import type { IMAdapter } from "../adapters/base.adapter.js";
import {
  loadCompanionState,
  minutesSince,
  recordSilenceFollowUp,
  shouldSendSilenceFollowUp,
  shouldSendProactiveFollowUp,
  recordProactiveFollowUp,
  getProactiveFollowUpMin,
} from "./state.js";
import { sendPersonaMessages } from "./send.util.js";
import {
  buildSessionSilencePrompt,
  buildProactiveFollowUpPrompt,
} from "./prompt.util.js";
import { generateCompanionText, shouldSkipResponse, isQuietHour } from "./client.util.js";

export interface ConversationWatcherOptions {
  adapters: readonly IMAdapter[];
  targetChatId: string;
  userId: string;
  personaName: string;
  silenceMin: number;
  checkIntervalSec: number;
  quietStart: string;
  quietEnd: string;
}

export class ConversationWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly options: ConversationWatcherOptions) {}

  start(): void {
    const { checkIntervalSec, silenceMin } = this.options;
    const followUpMin = getProactiveFollowUpMin();
    console.log(
      `[Conversation] 对话监听已启动：聊完 ${silenceMin} 分钟不回会追问；主动找你 ${followUpMin} 分钟不回会再反应`,
    );
    this.timer = setInterval(
      () => void this.check(),
      checkIntervalSec * 1000,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    console.log("[Conversation] 对话监听已停止");
  }

  private async check(): Promise<void> {
    if (this.running) return;

    const state = loadCompanionState();
    const sessionCheck = shouldSendSilenceFollowUp(state, this.options.silenceMin);
    const proactiveCheck = shouldSendProactiveFollowUp(state);

    if (sessionCheck.ok) {
      await this.handleSessionSilence(sessionCheck.silenceMin!);
      return;
    }

    if (proactiveCheck.ok) {
      await this.handleProactiveFollowUp(proactiveCheck.silenceMin!);
    }
  }

  private async handleSessionSilence(silenceMin: number): Promise<void> {
    this.running = true;
    const state = loadCompanionState();
    try {
      console.log(
        `[Conversation] 持续对话中你 ${Math.round(silenceMin)} 分钟没回，准备追问...`,
      );

      const prompt = buildSessionSilencePrompt(
        this.options.personaName,
        this.options.userId,
        silenceMin,
      );
      const text = await generateCompanionText(prompt, 200);
      if (!text || shouldSkipResponse(text)) return;

      const sent = await sendPersonaMessages(
        this.options.adapters,
        this.options.targetChatId,
        text,
      );
      if (sent) {
        recordSilenceFollowUp(state.lastBotReplyAt!, text);
        console.log(`[Conversation] 已追问：${text.slice(0, 50).replace(/\n/g, " ")}...`);
      }
    } catch (err) {
      console.error("[Conversation] 追问失败:", err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }

  private async handleProactiveFollowUp(silenceMin: number): Promise<void> {
    const now = new Date();
    if (isQuietHour(now, this.options.quietStart, this.options.quietEnd)) return;

    this.running = true;
    const state = loadCompanionState();
    try {
      console.log(
        `[Conversation] 主动找你后你 ${Math.round(silenceMin)} 分钟没回，正在思考反应...`,
      );

      const prompt = buildProactiveFollowUpPrompt(
        this.options.personaName,
        this.options.userId,
        silenceMin,
        now,
      );
      const text = await generateCompanionText(prompt, 250);
      if (!text || shouldSkipResponse(text)) {
        console.log("[Conversation] 思考结果：暂不追问");
        recordProactiveFollowUp(state.lastProactiveAt!, "");
        return;
      }

      const sent = await sendPersonaMessages(
        this.options.adapters,
        this.options.targetChatId,
        text,
      );
      if (sent) {
        recordProactiveFollowUp(state.lastProactiveAt!, text);
        console.log(`[Conversation] 已反应：${text.slice(0, 50).replace(/\n/g, " ")}...`);
      }
    } catch (err) {
      console.error("[Conversation] 主动后追问失败:", err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }
}
