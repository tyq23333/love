import fs from "fs";
import { persistPath } from "../util/persist.js";

const STATE_FILE = persistPath(".companion-state.json");

export interface CompanionState {
  /** 用户上次发消息时间 */
  lastUserMessageAt?: string;
  /** Bot 上次回复时间 */
  lastBotReplyAt?: string;
  /** 上次主动找用户的时间 */
  lastProactiveAt?: string;
  /** 最近一次用户消息摘要 */
  lastUserText?: string;
  /** 最近一次 Bot 回复摘要 */
  lastBotText?: string;
  /** 累计主动消息次数 */
  proactiveCount: number;
  /** 最近一次主动找用户发的内容 */
  lastProactiveText?: string;
  /** 已对哪次主动消息做过「不回追问」 */
  proactiveFollowUpForAt?: string;
  /** 已对哪次 Bot 回复做过「怎么不理我」追问 */
  silenceFollowUpForBotReplyAt?: string;
}

const defaultState = (): CompanionState => ({ proactiveCount: 0 });

export function loadCompanionState(): CompanionState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8").trim();
    if (!raw) return defaultState();
    return { ...defaultState(), ...(JSON.parse(raw) as CompanionState) };
  } catch {
    return defaultState();
  }
}

export function saveCompanionState(state: CompanionState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.warn("[Companion] 无法保存状态:", err);
  }
}

export function recordUserMessage(text: string): void {
  const state = loadCompanionState();
  state.lastUserMessageAt = new Date().toISOString();
  state.lastUserText = text.slice(0, 200);
  saveCompanionState(state);
}

export function recordBotReply(text: string): void {
  const state = loadCompanionState();
  state.lastBotReplyAt = new Date().toISOString();
  state.lastBotText = text.slice(0, 200);
  saveCompanionState(state);
}

export function recordSilenceFollowUp(botReplyAt: string, followUpText?: string): void {
  const state = loadCompanionState();
  state.silenceFollowUpForBotReplyAt = botReplyAt;
  if (followUpText) state.lastBotText = followUpText.slice(0, 200);
  saveCompanionState(state);
}

/** 持续对话窗口：用户在此时间内发过消息，视为还在聊 */
export function getSessionWindowMin(): number {
  const n = Number(process.env["CONVERSATION_SESSION_WINDOW_MIN"] ?? "15");
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/** 持续对话中，Bot 回复后用户沉默多久该追问 */
export function getSilenceFollowUpMin(): number {
  const n = Number(process.env["CONVERSATION_SILENCE_MIN"] ?? "2");
  return Number.isFinite(n) && n > 0 ? n : 2;
}

export interface SilenceFollowUpCheck {
  ok: boolean;
  silenceMin?: number;
  reason?: string;
}

/**
 * 判断是否处于「持续对话中 Bot 已回、用户在沉默」且该追问了。
 * - 用户最近仍在聊（session window 内发过消息）
 * - Bot 比用户后说话（等用户回）
 * - 沉默超过 silenceMin 但未超过 session window（对话还没彻底冷掉）
 * - 同一条 Bot 回复只追问一次
 */
export function shouldSendSilenceFollowUp(
  state: CompanionState,
  silenceMin = getSilenceFollowUpMin(),
): SilenceFollowUpCheck {
  const sessionWindow = getSessionWindowMin();

  if (!state.lastUserMessageAt || !state.lastBotReplyAt) {
    return { ok: false, reason: "no_messages" };
  }

  const userAt = new Date(state.lastUserMessageAt).getTime();
  const botAt = new Date(state.lastBotReplyAt).getTime();

  // 若 Bot 最后一条是主动找你，走「主动后不回」逻辑，不走持续对话追问
  if (state.lastProactiveAt && state.lastBotReplyAt === state.lastProactiveAt) {
    return { ok: false, reason: "last_was_proactive" };
  }

  // Bot 必须比用户后说话（用户在等回 / 已读不回）
  if (botAt <= userAt) {
    return { ok: false, reason: "user_spoke_last" };
  }

  // 同一条 Bot 回复只追问一次
  if (state.silenceFollowUpForBotReplyAt === state.lastBotReplyAt) {
    return { ok: false, reason: "already_followed_up" };
  }

  const silence = minutesSince(state.lastBotReplyAt);
  if (silence == null || silence < silenceMin) {
    return { ok: false, reason: "too_soon" };
  }

  // 用户最后一次发言仍在持续对话窗口内
  const userIdle = minutesSince(state.lastUserMessageAt);
  if (userIdle == null || userIdle > sessionWindow) {
    return { ok: false, reason: "session_ended" };
  }

  // Bot 回复距离用户上一条不能太久（否则不算「刚聊完」）
  const userToBotGap = (botAt - userAt) / 60_000;
  if (userToBotGap > sessionWindow) {
    return { ok: false, reason: "stale_exchange" };
  }

  return { ok: true, silenceMin: silence };
}

export function recordProactiveMessage(text: string): void {
  const state = loadCompanionState();
  const now = new Date().toISOString();
  state.lastProactiveAt = now;
  state.lastProactiveText = text.slice(0, 200);
  state.lastBotReplyAt = now;
  state.lastBotText = text.slice(0, 200);
  state.proactiveCount += 1;
  saveCompanionState(state);
}

export function recordProactiveFollowUp(proactiveAt: string, text: string): void {
  const state = loadCompanionState();
  state.proactiveFollowUpForAt = proactiveAt;
  if (text) state.lastBotText = text.slice(0, 200);
  saveCompanionState(state);
}

/** 主动找你之后，你多久没回该再反应（分钟） */
export function getProactiveFollowUpMin(): number {
  const n = Number(process.env["COMPANION_PROACTIVE_FOLLOWUP_MIN"] ?? "10");
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export interface ProactiveFollowUpCheck {
  ok: boolean;
  silenceMin?: number;
  reason?: string;
}

/** 主动找你之后长时间不回，该再思考反应 */
export function shouldSendProactiveFollowUp(
  state: CompanionState,
  followUpMin = getProactiveFollowUpMin(),
): ProactiveFollowUpCheck {
  if (!state.lastProactiveAt || !state.lastUserMessageAt) {
    return { ok: false, reason: "no_proactive" };
  }

  const proactiveAt = new Date(state.lastProactiveAt).getTime();
  const userAt = new Date(state.lastUserMessageAt).getTime();

  // 主动消息必须比用户最后发言更晚（用户还没回这次主动）
  if (proactiveAt <= userAt) {
    return { ok: false, reason: "user_replied" };
  }

  if (state.proactiveFollowUpForAt === state.lastProactiveAt) {
    return { ok: false, reason: "already_followed_up" };
  }

  const silence = minutesSince(state.lastProactiveAt);
  if (silence == null || silence < followUpMin) {
    return { ok: false, reason: "too_soon" };
  }

  return { ok: true, silenceMin: silence };
}

export function minutesSince(iso?: string): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

export function formatDurationZh(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}
