import fs from "fs";
import os from "os";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import HttpsProxyAgent from "https-proxy-agent";
import { anthropicProxyUrl } from "../util/proxy.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager } from "./session.manager.js";
import type { PermissionManager } from "../permissions/permission.manager.js";
import { getPersona, buildSystemPrompt } from "../clawra/profile.js";
import { processSelfieTags } from "../clawra/selfie.util.js";
import { buildStickerAvoidHint } from "../services/sticker.context.js";
import {
  loadHistoryWithFallback,
  saveHistory,
  deleteHistory,
  deleteAllHistoryForUser,
  countHistoryFiles,
  getMaxHistoryMessages,
  getHistoryKeyAliases,
} from "../services/history.store.js";
import { loadRecentUserTexts } from "../services/message.logger.js";
import type { IncomingImage } from "../adapters/base.adapter.js";
import { buildUserMessageContent, historyPlaceholder } from "./message-content.js";
import { prepareImagesForVision } from "./image-preprocess.js";
import { isVisionPreflightEnabled, preflightImageAnalysis } from "./vision-preflight.js";
import {
  saveRecentImages,
  saveImageDescription,
  getRecentImages,
  getRecentImageDescription,
  isAskingAboutRecentImage,
  looksLikeVisionRefusal,
  buildVisionRetryHint,
} from "./image.context.js";

export class AuthenticationError extends Error {
  readonly _tag = "AuthenticationError" as const;
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export function isAuthenticationError(err: unknown): err is AuthenticationError {
  return err instanceof Error && (err as { _tag?: string })._tag === "AuthenticationError";
}

function isAuthRelatedError(errMsg: string): boolean {
  return /401|403|authentication_error|authenticate|forbidden|request not allowed/i.test(errMsg);
}

function resolveConfig(): {
  apiKey: string;
  baseUrl?: string;
  model: string;
  useAgentSdk: boolean;
  proxyUrl?: string;
} {
  const fileSettings = (() => {
    try {
      const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as { env?: Record<string, string> };
      return settings.env ?? {};
    } catch {
      return {};
    }
  })();

  const apiKey =
    process.env["ANTHROPIC_API_KEY"] ??
    fileSettings["ANTHROPIC_AUTH_TOKEN"] ??
    "";
  const baseUrlRaw =
    process.env["ANTHROPIC_BASE_URL"] ??
    fileSettings["ANTHROPIC_BASE_URL"] ??
    undefined;
  // SDK 会自动追加 /v1，SillyTavern 填的 .../v1 需要去掉后缀
  const baseUrl = baseUrlRaw?.replace(/\/v1\/?$/, "") || undefined;
  const model =
    process.env["ANTHROPIC_MODEL"] ??
    fileSettings["ANTHROPIC_MODEL"] ??
    "claude-sonnet-4-6";
  const useAgentSdk = process.env["USE_AGENT_SDK"] === "true";
  const proxyUrl = anthropicProxyUrl();

  return { apiKey, baseUrl, model, useAgentSdk, proxyUrl };
}

function createAnthropicClient(config: {
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
}): Anthropic {
  const httpAgent = config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined;
  if (httpAgent) {
    console.log(`[FLOW][Runner] 使用代理: ${config.proxyUrl}`);
  }
  return new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    httpAgent,
  });
}

export class ClaudeRunner {
  private readonly conversationHistory = new Map<string, MessageParam[]>();
  private readonly maxHistoryMessages = getMaxHistoryMessages();

  constructor(
    private readonly sessions: SessionManager,
    private readonly permissions: PermissionManager,
  ) {
    const count = countHistoryFiles();
    if (count > 0) {
      console.log(`[Memory] 已发现 ${count} 个持久化对话记录，重启后会自动恢复`);
    }
  }

  private getHistory(key: string): MessageParam[] {
    if (!this.conversationHistory.has(key)) {
      this.conversationHistory.set(key, loadHistoryWithFallback(key));
    }
    return this.conversationHistory.get(key)!;
  }

  private buildLogContextHint(userId: string, personaName: string): string {
    const aliasKeys = getHistoryKeyAliases(this.historyKey(userId, personaName));
    const personaNames = [...new Set(aliasKeys.map((k) => k.split(":")[1] ?? personaName))];
    const texts = loadRecentUserTexts(userId, personaNames, 8);
    if (texts.length === 0) return "";
    const lines = texts.map((t) => `- 「${t.slice(0, 80)}」`).join("\n");
    return `\n\n## 用户近期说过的话（重启前记录，供参考）\n${lines}\n请结合这些内容回复，不要遗忘。`;
  }

  getHistoryCount(userId: string, personaName: string): number {
    return this.getHistory(this.historyKey(userId, personaName)).length;
  }

  private persistHistory(key: string, history: MessageParam[]): void {
    this.conversationHistory.set(key, history);
    saveHistory(key, history);
  }

  private historyKey(userId: string, personaName: string): string {
    return `${userId}:${personaName.toLowerCase()}`;
  }

  private extractResponseText(response: { content: Array<{ type: string; text?: string }> }): string {
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") parts.push(block.text);
    }
    return parts.join("\n").trim() || "（无文本响应）";
  }

  async run(
    userId: string,
    userMessage: string,
    personaName: string,
    images?: IncomingImage[],
  ): Promise<string> {
    const msgPreview = images?.length
      ? `[图片×${images.length}] ${userMessage.slice(0, 20)}`
      : userMessage.slice(0, 30);
    console.log(`[FLOW][Runner] 开始处理 user=${userId} text="${msgPreview}"`);

    const config = resolveConfig();
    if (!config.apiKey) {
      throw new Error("未配置 ANTHROPIC_API_KEY，请在 .env 中填写");
    }

    if (config.useAgentSdk) {
      console.log(`[FLOW][Runner] 使用 Agent SDK: ${config.model}`);
      return this.runWithAgentSDK(userId, userMessage, personaName);
    }

    console.log(`[FLOW][Runner] 使用直连 API: model=${config.model} baseUrl=${config.baseUrl ?? "官方"}`);
    return this.runWithDirectAPI(userId, userMessage, personaName, config, images);
  }

  private async runWithDirectAPI(
    userId: string,
    userMessage: string,
    personaName: string,
    config: { apiKey: string; baseUrl?: string; model: string; proxyUrl?: string },
    images?: IncomingImage[],
  ): Promise<string> {
    const client = createAnthropicClient(config);

    const profile = getPersona(personaName);
    const key = this.historyKey(userId, personaName);
    const history = [...this.getHistory(key)];
    const logHint = history.length === 0 ? this.buildLogContextHint(userId, personaName) : "";

    // 用户追问刚才的图：重新附上缓存的图片
    let activeImages = images;
    if (!activeImages?.length && isAskingAboutRecentImage(userMessage)) {
      activeImages = getRecentImages(userId, personaName);
      if (activeImages?.length) {
        console.log(`[Vision] 用户追问图片，重新附上缓存图片×${activeImages.length}`);
      }
    }

    if (activeImages?.length) {
      activeImages = await prepareImagesForVision(activeImages);
      saveRecentImages(userId, personaName, activeImages);
    }

    let visionAnalysis: string | null = null;
    if (activeImages?.length && isVisionPreflightEnabled()) {
      visionAnalysis = await preflightImageAnalysis(
        client,
        config.model,
        activeImages,
        userMessage,
      );
    }

    let systemPrompt = buildSystemPrompt(profile, { useAgentSdk: false }) + logHint + buildStickerAvoidHint(userId, personaName);
    if (visionAnalysis) {
      systemPrompt += `\n\n## 图片客观识别（回复必须与此一致，禁止编造）\n${visionAnalysis}`;
    }
    const imgDesc = getRecentImageDescription(userId, personaName);
    if (!activeImages?.length && imgDesc && isAskingAboutRecentImage(userMessage)) {
      systemPrompt += `\n\n## 刚才那张图（客观识别记录）\n${imgDesc}\n用户现在在问这张图，结合上述内容用中文回答，不要编造。`;
    }

    console.log(
      `[Memory] 携带 ${history.length} 条历史 key=${key}${logHint ? " + 日志补全" : ""}${activeImages?.length ? ` + 图片×${activeImages.length}${visionAnalysis ? " + 预分析" : ""}` : ""}`,
    );

    const userContent = buildUserMessageContent(userMessage, activeImages, {
      hasPreflightAnalysis: !!visionAnalysis,
    });
    history.push({ role: "user", content: userContent });

    try {
      let response = await client.messages.create({
        model: config.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: history,
      });

      let text = this.extractResponseText(response);

      // 识图被拒或英文敷衍 → 重试一次
      if (activeImages?.length && looksLikeVisionRefusal(text)) {
        console.warn(`[Vision] 回复疑似拒答，重试: "${text.slice(0, 60)}..."`);
        history.pop();
        history.push({ role: "user", content: userContent });
        response = await client.messages.create({
          model: config.model,
          max_tokens: 4096,
          system: systemPrompt + buildVisionRetryHint(profile.name),
          messages: history,
        });
        text = this.extractResponseText(response);
      }

      text = await processSelfieTags(text, profile);

      history.push({ role: "assistant", content: text });
      while (history.length > this.maxHistoryMessages) {
        history.shift();
      }

      const lastUser = history[history.length - 2];
      if (lastUser?.role === "user" && activeImages?.length) {
        lastUser.content = historyPlaceholder(userMessage, activeImages);
        const toSave = visionAnalysis ?? (!looksLikeVisionRefusal(text) ? text : undefined);
        if (toSave) {
          saveImageDescription(userId, personaName, toSave);
        }
      }
      this.persistHistory(key, history);

      console.log(`[FLOW][Runner] 生成回复 user=${userId} reply="${text.slice(0, 40)}..."`);
      return text;
    } catch (err) {
      history.pop();
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[FLOW][Runner] API 错误: ${errMsg.slice(0, 200)}`);
      if (isAuthRelatedError(errMsg)) {
        throw new AuthenticationError(
          config.proxyUrl
            ? `API 请求失败 (${errMsg.slice(0, 120)})。请检查 ANTHROPIC_BASE_URL 和 ANTHROPIC_MODEL 是否与 SillyTavern 一致`
            : `API 请求被拒绝 (${errMsg.slice(0, 120)})。请在 .env 中添加 HTTPS_PROXY=http://127.0.0.1:7890（Clash 默认端口）`,
        );
      }
      throw err;
    }
  }

  private async runWithAgentSDK(userId: string, userMessage: string, personaName: string): Promise<string> {
    const session = this.sessions.getOrCreate(userId, personaName);
    const abortController = new AbortController();

    const profile = getPersona(personaName);
    const systemPrompt = buildSystemPrompt(profile, { useAgentSdk: true });

    const q = query({
      prompt: userMessage,
      options: {
        abortController,
        maxTurns: 10,
        allowedTools: this.permissions.getAllowedTools(),
        cwd: this.permissions.getWorkingDir(),
        agent: personaName,
        agents: {
          [personaName]: {
            description: `${profile.name} - virtual persona`,
            prompt: systemPrompt,
            tools: this.permissions.getAllowedTools(),
          },
        },
        ...(session.sdkSessionId ? { resume: session.sdkSessionId } : {}),
      },
    });

    let finalText = "";

    try {
      for await (const event of q) {
        switch (event.type) {
          case "result":
            if (event.subtype === "success") {
              finalText = event.result;
              this.sessions.setSdkSessionId(userId, personaName, event.session_id);
              const replyPreview = finalText.slice(0, 40).replace(/\n/g, " ");
              console.log(`[FLOW][Runner] 生成回复 user=${userId} reply="${replyPreview}..."`);
            } else {
              const err = event as { errors?: string[] };
              const errMsg = err.errors?.join("; ") || "执行失败";
              if (isAuthRelatedError(errMsg)) {
                throw new AuthenticationError(errMsg);
              }
              throw new Error(errMsg);
            }
            break;

          case "assistant":
            if (!event.error) {
              for (const block of event.message.content) {
                if (block.type === "text" && !finalText) {
                  finalText = block.text;
                }
              }
            }
            break;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[FLOW][Runner] 捕获异常: ${errMsg.slice(0, 200)}`);
      if (err instanceof AuthenticationError) {
        throw err;
      }
      if (isAuthRelatedError(errMsg)) {
        throw new AuthenticationError(errMsg);
      }
      throw err;
    }

    return finalText.trim() || "（无响应）";
  }

  getReplyPrefix(personaName: string): string {
    return getPersona(personaName).replyPrefix;
  }

  getContentPrefix(personaName: string): string {
    return getPersona(personaName).contentPrefix;
  }

  clearSession(userId: string, personaName: string): void {
    const key = this.historyKey(userId, personaName);
    this.sessions.clear(userId, personaName);
    this.conversationHistory.delete(key);
    deleteHistory(key);
  }

  clearAllSessions(userId: string): void {
    this.sessions.clearAll(userId);
    for (const key of [...this.conversationHistory.keys()]) {
      if (key.startsWith(`${userId}:`)) {
        this.conversationHistory.delete(key);
        deleteHistory(key);
      }
    }
    deleteAllHistoryForUser(userId);
  }
}
