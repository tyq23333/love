import type { IMAdapter } from "../adapters/base.adapter.js";
import {
  loadCompanionState,
  recordProactiveMessage,
  minutesSince,
} from "./state.js";
import { sendPersonaMessages } from "./send.util.js";
import { buildProactiveThinkPrompt } from "./prompt.util.js";
import {
  generateCompanionText,
  shouldSkipResponse,
  isQuietHour,
} from "./client.util.js";

export interface CompanionOptions {
  adapters: readonly IMAdapter[];
  targetChatId: string;
  userId: string;
  personaName: string;
  checkIntervalMin: number;
  minIdleMin: number;
  quietStart: string;
  quietEnd: string;
}

export class AutonomousCompanion {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly options: CompanionOptions) {}

  start(): void {
    const { checkIntervalMin } = this.options;
    console.log(
      `[Companion] 自主陪伴已启动，每 ${checkIntervalMin} 分钟思考一次（结合聊天记录）`,
    );
    setTimeout(() => void this.thinkAndMaybeReachOut(), 2 * 60_000);
    this.timer = setInterval(
      () => void this.thinkAndMaybeReachOut(),
      checkIntervalMin * 60_000,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    console.log("[Companion] 自主陪伴已停止");
  }

  private async thinkAndMaybeReachOut(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const now = new Date();
      const { minIdleMin, quietStart, quietEnd, targetChatId, userId, personaName } =
        this.options;
      const state = loadCompanionState();

      if (isQuietHour(now, quietStart, quietEnd)) {
        console.log("[Companion] 静默时段，跳过");
        return;
      }

      const idleMin = minutesSince(state.lastUserMessageAt);
      if (idleMin != null && idleMin < minIdleMin) {
        console.log(`[Companion] 用户 ${Math.round(idleMin)} 分钟前还在聊，暂不打扰`);
        return;
      }

      if (!state.lastUserMessageAt) {
        console.log("[Companion] 用户尚未发过消息，无法主动（需先聊一次）");
        return;
      }

      console.log("[Companion] 正在结合聊天记录思考要不要找你...");
      const prompt = buildProactiveThinkPrompt(personaName, userId, now);
      const text = await generateCompanionText(prompt, 350);

      if (!text || shouldSkipResponse(text)) {
        console.log("[Companion] 思考结果：暂时不发");
        return;
      }

      console.log(`[Companion] 决定主动找你：${text.slice(0, 60).replace(/\n/g, " ")}...`);
      const sent = await sendPersonaMessages(this.options.adapters, targetChatId, text);
      if (sent) recordProactiveMessage(text);
    } catch (err) {
      console.error("[Companion] 思考失败:", err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }
}
