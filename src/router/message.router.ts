import type { IMAdapter, IncomingMessage, IncomingImage } from "../adapters/base.adapter.js";
import type { ClaudeRunner } from "../runner/claude.runner.js";
import { isAuthenticationError } from "../runner/claude.runner.js";
import type { PermissionManager } from "../permissions/permission.manager.js";
import { logMessage } from "../services/message.logger.js";
import { getStickerPath, parseStickerTags } from "../services/sticker.service.js";
import { recordStickersUsed } from "../services/sticker.context.js";
import { splitMultiMessages, capMultiMessages, maxReplyParts, sleep, messageDelayMs } from "../services/reply.service.js";
import { recordUserMessage, recordBotReply } from "../companion/state.js";

interface QueueItem {
  adapter: IMAdapter;
  chatId: string;
  userId: string;
  text: string;
  personaName: string;
  images?: IncomingImage[];
}

export class MessageRouter {
  private readonly adapters: IMAdapter[] = [];
  private readonly queues = new Map<string, QueueItem[]>();
  private readonly processing = new Set<string>();
  private readonly recentMessages = new Map<string, number>();

  constructor(
    private readonly runner: ClaudeRunner,
    private readonly permissions: PermissionManager,
    private readonly personaNames: string[],
    private defaultPersonaName: string,
  ) {}

  setDefaultPersona(name: string): boolean {
    if (!this.personaNames.includes(name.toLowerCase())) return false;
    this.defaultPersonaName = name.toLowerCase();
    return true;
  }

  registerAdapter(adapter: IMAdapter): void {
    this.adapters.push(adapter);
    adapter.onMessage((msg) => this.handle(adapter, msg));
    console.log(`[Router] Registered adapter: ${adapter.platform}`);
  }

  private parsePersona(raw: string): { personaName: string; text: string } {
    const trimmed = raw.trim();
    const match = /^@?(\S+?)(?::|[,，、]| )\s*(.*)$/s.exec(trimmed);
    if (match) {
      const candidate = match[1].toLowerCase();
      if (this.personaNames.includes(candidate)) {
        return { personaName: candidate, text: match[2].trim() };
      }
    }
    return { personaName: this.defaultPersonaName, text: trimmed };
  }

  private async handle(adapter: IMAdapter, msg: IncomingMessage): Promise<void> {
    const textPreview = msg.text.slice(0, 30);

    const contentKey = msg.images?.length
      ? `${msg.userId}:img:${msg.images[0]!.data.slice(0, 32)}`
      : `${msg.userId}:${msg.text}`;
    const now = Date.now();
    const lastSeen = this.recentMessages.get(contentKey);
    if (lastSeen !== undefined && now - lastSeen < 120_000) {
      console.log(`[FLOW][Router] 重复跳过 user=${msg.userId} text="${textPreview}"`);
      return;
    }
    this.recentMessages.set(contentKey, now);
    if (this.recentMessages.size > 500) {
      const cutoff = now - 120_000;
      for (const [k, t] of this.recentMessages) {
        if (t < cutoff) this.recentMessages.delete(k);
      }
    }

    if (!this.permissions.isUserAllowed(msg.userId)) {
      await adapter.sendMessage({ chatId: msg.chatId, text: "❌ 无访问权限" });
      return;
    }

    const defaultMatch = /^\/default\s+(\S+)$/i.exec(msg.text.trim());
    if (defaultMatch) {
      const name = defaultMatch[1];
      if (this.setDefaultPersona(name)) {
        await adapter.sendMessage({ chatId: msg.chatId, text: `✅ 默认虚拟人已切换为 ${name}` });
      } else {
        const available = this.personaNames.join("、");
        await adapter.sendMessage({ chatId: msg.chatId, text: `❌ 找不到 "${name}"，可用：${available}` });
      }
      return;
    }

    if (msg.text.trim() === "/personas") {
      const list = this.personaNames
        .map((n) => (n === this.defaultPersonaName ? `${n}（默认）` : n))
        .join("\n");
      await adapter.sendMessage({ chatId: msg.chatId, text: `可用虚拟人：\n${list}` });
      return;
    }

    if (msg.text.trim() === "__CLEAR_SESSION__" || msg.text.trim() === "/clear") {
      const { personaName } = this.parsePersona(msg.text.trim().replace(/^\/clear\s*/, ""));
      this.runner.clearSession(msg.userId, personaName);
      return;
    }

    if (msg.text.trim() === "/clearall") {
      this.runner.clearAllSessions(msg.userId);
      await adapter.sendMessage({ chatId: msg.chatId, text: "✅ 所有虚拟人对话已重置" });
      return;
    }

    if (msg.text.trim() === "/memory") {
      const count = this.runner.getHistoryCount(msg.userId, this.defaultPersonaName);
      const rounds = Math.floor(count / 2);
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `当前对话记忆：${count} 条消息（约 ${rounds} 轮）\n发送 /clear 可清空`,
      });
      return;
    }

    if (msg.text.trim() === "/testimage") {
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: "测试图片",
        mediaUrl: "https://picsum.photos/400/300.jpg",
      });
      return;
    }

    const { personaName, text: messageText } = this.parsePersona(msg.text);
    if (!messageText && !msg.images?.length) return;

    logMessage({
      timestamp: new Date().toISOString(),
      source: adapter.platform,
      userId: msg.userId,
      personaName,
      text: messageText || (msg.images?.length ? "[用户发来图片]" : messageText),
    });
    recordUserMessage(messageText || "[用户发来图片]");

    const processingKey = `${msg.userId}:${personaName}`;
    const item: QueueItem = {
      adapter,
      chatId: msg.chatId,
      userId: msg.userId,
      text: messageText,
      personaName,
      images: msg.images,
    };

    if (this.processing.has(processingKey)) {
      const queue = this.queues.get(processingKey) ?? [];
      const isDuplicateInQueue = queue.some(
        (q) => q.text === messageText && q.adapter.platform === adapter.platform,
      );
      if (isDuplicateInQueue) {
        console.log(`[Router][${personaName}] 队列中已存在相同消息，丢弃`);
        return;
      }
      queue.push(item);
      this.queues.set(processingKey, queue);
      console.log(`[Router][${personaName}] 消息已入队（队列长度: ${queue.length}）`);
      return;
    }

    void this.processItem(item, processingKey);
  }

  private async processItem(item: QueueItem, processingKey: string): Promise<void> {
    const { adapter, chatId, userId, text, personaName, images } = item;
    const preview = images?.length ? `[图片×${images.length}]` : text.slice(0, 30);
    console.log(`[FLOW][Router] 调用Runner user=${userId} text="${preview}"`);
    this.processing.add(processingKey);
    try {
      const response = await this.runner.run(userId, text, personaName, images);
      const replyPreview = response.slice(0, 40).replace(/\n/g, " ");
      console.log(`[FLOW][Router] 收到回复 user=${userId} reply="${replyPreview}..."`);

      const prefix = this.runner.getReplyPrefix(personaName);
      const contentPrefix = this.runner.getContentPrefix(personaName);

      const { stickers, cleanText } = parseStickerTags(response);

      // 发送表情包
      for (const stickerName of stickers) {
        const stickerPath = getStickerPath(stickerName);
        if (stickerPath) {
          console.log(`[FLOW][Router] 发送表情包 user=${userId} sticker=${stickerName}`);
          await adapter.sendMessage({
            chatId,
            text: "",
            mediaUrl: `file://${stickerPath}`,
            fallbackText: `[表情:${stickerName}]`,
          });
          await sleep(messageDelayMs(0, adapter.platform));
        } else {
          console.warn(`[FLOW][Router] 未知表情包: ${stickerName}`);
        }
      }
      if (stickers.length > 0) {
        recordStickersUsed(userId, personaName, stickers);
      }

      const textToSend = cleanText || (stickers.length > 0 ? "" : response);
      const imageUrlMatch =
        textToSend.match(/https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif)(?:\?\S*)?/i) ??
        textToSend.match(/https?:\/\/v3b\.fal\.media\/\S+/i);

      if (imageUrlMatch) {
        const rawUrl = imageUrlMatch[0];
        const urlIndex = textToSend.indexOf(rawUrl);
        const beforeUrl = textToSend
          .slice(0, urlIndex)
          .replace(/!\[.*?\]\(.*?\)/g, "")
          .trim();
        const afterUrl = textToSend
          .slice(urlIndex + rawUrl.length)
          .replace(/!\[.*?\]\(.*?\)/g, "")
          .trim();

        const partsBefore = beforeUrl
          ? capMultiMessages(splitMultiMessages(beforeUrl), Math.min(2, maxReplyParts()))
          : [];
        const partsAfter = afterUrl
          ? capMultiMessages(
              splitMultiMessages(afterUrl),
              Math.max(1, maxReplyParts() - partsBefore.length),
            )
          : [];
        const imageUrl = rawUrl.includes("fal.media")
          ? `https://wsrv.nl/?url=${encodeURIComponent(rawUrl)}&n=-1`
          : rawUrl;

        let sentCount = 0;
        for (let i = 0; i < partsBefore.length; i++) {
          if (sentCount > 0) await sleep(messageDelayMs(sentCount, adapter.platform));
          const partText =
            sentCount === 0 ? `${prefix}${contentPrefix}${partsBefore[i]}` : partsBefore[i]!;
          await adapter.sendMessage({ chatId, text: partText });
          sentCount++;
        }

        if (sentCount > 0) await sleep(messageDelayMs(sentCount, adapter.platform));
        console.log(`[FLOW][Router] 发送图片回复 user=${userId} textParts=${partsBefore.length}+${partsAfter.length}`);
        await adapter.sendMessage({
          chatId,
          text: "",
          mediaUrl: imageUrl,
          fallbackText: `[图片] ${rawUrl}`,
        });
        sentCount++;

        for (let i = 0; i < partsAfter.length; i++) {
          await sleep(messageDelayMs(sentCount + i, adapter.platform));
          await adapter.sendMessage({ chatId, text: partsAfter[i]! });
        }

        recordBotReply(textToSend);
        logMessage({
          timestamp: new Date().toISOString(),
          source: adapter.platform,
          userId,
          personaName,
          text: textToSend,
          role: "assistant",
        });
      } else if (textToSend) {
        const parts = splitMultiMessages(textToSend);
        console.log(`[FLOW][Router] 发送 ${parts.length} 条消息 user=${userId}`);
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) await sleep(messageDelayMs(i, adapter.platform));
          const partText = i === 0 ? `${prefix}${contentPrefix}${parts[i]}` : parts[i];
          await adapter.sendMessage({ chatId, text: partText });
        }
        recordBotReply(textToSend);
        logMessage({
          timestamp: new Date().toISOString(),
          source: adapter.platform,
          userId,
          personaName,
          text: textToSend,
          role: "assistant",
        });
      }
    } catch (err) {
      const errDetail = err instanceof Error ? err.message : String(err);
      console.error(`[FLOW][Router] 捕获错误: ${errDetail.slice(0, 200)}`);
      if (isAuthenticationError(err)) {
        console.warn(`[FLOW][Router] API 配置错误: ${err.message.slice(0, 100)}`);
        await adapter.sendMessage({
          chatId,
          text: `❌ Claude API 配置有误：${err.message}`,
        });
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[FLOW][Router] 处理错误 user=${userId}: ${detail}`);
      await adapter.sendMessage({ chatId, text: `❌ 出错了：${detail}` });
    } finally {
      this.processing.delete(processingKey);

      const queue = this.queues.get(processingKey);
      if (queue && queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.queues.delete(processingKey);
        void this.processItem(next, processingKey);
      }
    }
  }

  async startAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.start()));
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.stop()));
  }
}
