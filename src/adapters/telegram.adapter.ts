import axios from "axios";
import { Bot, type Context } from "grammy";
import type { IMAdapter, IncomingMessage, OutgoingMessage, MessageHandler } from "./base.adapter.js";
import { TranscriptionService } from "../services/transcription.service.js";

const TG_MAX_LEN = 4000;

export class TelegramAdapter implements IMAdapter {
  readonly platform = "telegram" as const;
  private readonly bot: Bot;
  private readonly token: string;
  private readonly transcription: TranscriptionService;
  private handler?: MessageHandler;

  constructor(token: string) {
    this.token = token;
    this.bot = new Bot(token);
    this.transcription = new TranscriptionService(
      process.env["WHISPER_MODEL"] ?? "base",
    );
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.bot.on("message:text", async (ctx: Context) => {
      if (!this.handler || !ctx.message?.text) return;
      await this.handler(this.toIncoming(ctx, ctx.message.text));
    });

    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "你好！我是 Claude 助手。\n/clear - 清空对话历史\n/help - 使用说明",
      );
    });

    this.bot.command("clear", async (ctx) => {
      if (!this.handler) return;
      await this.handler(this.toIncoming(ctx, "__CLEAR_SESSION__"));
      await ctx.reply("✓ 对话历史已清空");
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        "直接发消息即可与 Claude 对话。\n\n" +
          "支持的命令：\n" +
          "/clear - 清空对话历史，开始新对话\n" +
          "/help - 显示此帮助",
      );
    });

    this.bot.on("message:voice", async (ctx: Context) => {
      if (!this.handler || !ctx.message?.voice) return;
      const statusMsg = await ctx.reply("🎤 正在识别语音...");
      try {
        const fileInfo = await ctx.api.getFile(ctx.message.voice.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;
        const res = await axios.get<ArrayBuffer>(fileUrl, { responseType: "arraybuffer" });
        const text = await this.transcription.transcribe(Buffer.from(res.data), "ogg");
        if (!text) {
          await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "⚠️ 语音识别失败，请重试");
          return;
        }
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `🎤 ${text}`);
        await this.handler(this.toIncoming(ctx, text));
      } catch (err) {
        console.error("[Telegram] Voice error:", err);
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "⚠️ 语音处理失败，请重试").catch(() => {});
      }
    });

    this.bot.catch((err) => {
      console.error("[Telegram] Error:", err.message);
    });
  }

  private toIncoming(ctx: Context, text: string): IncomingMessage {
    return {
      userId: String(ctx.from?.id ?? "unknown"),
      chatId: String(ctx.chat?.id ?? "unknown"),
      text,
      platform: "telegram",
      timestamp: new Date(),
    };
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    if (msg.mediaUrl) {
      const response = await axios.get<ArrayBuffer>(msg.mediaUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(response.data);
      const { InputFile } = await import("grammy");
      await this.bot.api.sendPhoto(msg.chatId, new InputFile(buffer, "photo.jpg"), {
        caption: msg.text || undefined,
      });
      return;
    }
    const chunks = this.splitText(msg.text);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(msg.chatId, chunk);
    }
  }

  async start(): Promise<void> {
    console.log("[Telegram] Starting bot...");
    await this.bot.start({ onStart: () => console.log("[Telegram] Bot ready") });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    console.log("[Telegram] Bot stopped");
  }

  private splitText(text: string): string[] {
    if (text.length <= TG_MAX_LEN) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += TG_MAX_LEN) {
      chunks.push(text.slice(i, i + TG_MAX_LEN));
    }
    return chunks;
  }
}
