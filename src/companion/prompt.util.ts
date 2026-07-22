import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { PersonaProfile } from "../clawra/types.js";
import { getPersona, buildNicknameHint } from "../clawra/profile.js";
import { buildStickerPromptHint } from "../services/sticker.service.js";
import {
  loadHistoryWithFallback,
  getHistoryKeyAliases,
} from "../services/history.store.js";
import { loadRecentUserTexts } from "../services/message.logger.js";
import {
  loadCompanionState,
  minutesSince,
  formatDurationZh,
  type CompanionState,
} from "./state.js";

export function companionHistoryKey(userId: string, personaName: string): string {
  return `${userId}:${personaName.toLowerCase()}`;
}

export function loadRecentChatContext(
  userId: string,
  personaName: string,
  limit = 14,
): string {
  const key = companionHistoryKey(userId, personaName);
  const history = loadHistoryWithFallback(key);
  const recent = history.slice(-limit);

  if (recent.length > 0) {
    return recent
      .map((m) => formatMessageLine(m))
      .join("\n");
  }

  const personaNames = [
    ...new Set(getHistoryKeyAliases(key).map((k) => k.split(":")[1] ?? personaName)),
  ];
  const userTexts = loadRecentUserTexts(userId, personaNames, 8);
  if (userTexts.length === 0) return "（暂无聊天记录，先随意聊几句）";

  return userTexts.map((t) => `用户说过：「${t.slice(0, 100)}」`).join("\n");
}

function formatMessageLine(m: MessageParam): string {
  const who = m.role === "user" ? "用户" : "你";
  const text =
    typeof m.content === "string"
      ? m.content.replace(/\n---\n/g, " / ").replace(/\s+/g, " ").trim()
      : "";
  return `${who}：${text.slice(0, 150)}`;
}

export function buildPersonaBlock(profile: PersonaProfile): string {
  return `## 你是谁
${profile.name}，${profile.gender}，正在和用户谈恋爱。

## 性格
${profile.personality.join("、")}

## 爱好（可以拿来聊日常）
${profile.hobbies.join("、")}

## 说话风格
${profile.speakingStyle}${buildNicknameHint(profile)}`;
}

export function buildOutputRules(allowSkip = true): string {
  const skipRule = allowSkip
    ? "如果不想发消息，**只输出一行**：SKIP\n\n"
    : "";
  return `${skipRule}## 输出格式
- 1-3 条短微信，用 --- 分隔
- 像真人发消息，口语化，每条不超过两句
- 表情可选，换着用，不要总 huaixiao（详见下方表情说明）
- 不要解释、不要引号、不要暴露 AI 身份
- **禁止套话**：不要每次都说「想你了」「在干嘛呀」这种空泛句子${buildStickerPromptHint()}`;
}

function buildStateBlock(state: CompanionState, now: Date): string {
  const idleMin = minutesSince(state.lastUserMessageAt);
  const gapMin = minutesSince(state.lastProactiveAt);
  const timeStr = now.toLocaleString("zh-CN", {
    timeZone: process.env["COMPANION_TIMEZONE"] ?? "Asia/Shanghai",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `## 当前时间
${timeStr}

## 当前状态
- 用户上次发消息：${idleMin != null ? `${formatDurationZh(idleMin)}前` : "还没有"}
${state.lastUserText ? `- 用户上次说：「${state.lastUserText}」` : ""}
${state.lastBotText ? `- 你上次回复：「${state.lastBotText}」` : ""}
- 你上次主动找 ta：${gapMin != null ? `${formatDurationZh(gapMin)}前` : "还没有"}
${state.lastProactiveText ? `- 你上次主动说：「${state.lastProactiveText}」` : ""}
- 累计主动找过 ${state.proactiveCount} 次`;
}

/** 自主陪伴：长时间没聊，考虑是否主动找 */
export function buildProactiveThinkPrompt(
  personaName: string,
  userId: string,
  now: Date,
): string {
  const profile = getPersona(personaName);
  const state = loadCompanionState();
  const chatContext = loadRecentChatContext(userId, personaName);

  return `${buildPersonaBlock(profile)}

${buildStateBlock(state, now)}

## 最近聊天记录
${chatContext}

## 任务
像真正的恋人一样，**自己思考**现在要不要主动发微信找 ta。

发什么：
- 必须结合上面聊天记录和你的性格，说**具体、生活化**的内容
- 可以：分享你正在做的事、提起之前聊过的细节、关心 ta 的状态、调侃、撒娇、发牢骚、分享见闻
- 要有画面感，像真人在发微信，每次风格尽量不同
- 考虑时间是否合适、会不会打扰、距离上次聊的内容是否自然

${buildOutputRules(true)}`;
}

/** 主动找你之后，你长时间不回 */
export function buildProactiveFollowUpPrompt(
  personaName: string,
  userId: string,
  silenceMin: number,
  now: Date,
): string {
  const profile = getPersona(personaName);
  const state = loadCompanionState();
  const chatContext = loadRecentChatContext(userId, personaName);

  return `${buildPersonaBlock(profile)}

${buildStateBlock(state, now)}

## 最近聊天记录
${chatContext}

## 当前情况（重要）
你之前**主动**找 ta 发了消息，但 ta 已经 ${Math.round(silenceMin)} 分钟没回你了。
${state.lastProactiveText ? `你主动说的是：「${state.lastProactiveText}」` : ""}

## 任务
结合你的人设和之前的聊天，**自己思考**现在该怎么反应。
可以：再追问一句、表达担心、半开玩笑地催、或者觉得不该打扰就 SKIP。
不要重复你刚才主动发过的内容，要有新的角度或情绪变化。

${buildOutputRules(true)}`;
}

/** 持续对话中，你回完消息后对方沉默 */
export function buildSessionSilencePrompt(
  personaName: string,
  userId: string,
  silenceMin: number,
): string {
  const profile = getPersona(personaName);
  const state = loadCompanionState();
  const chatContext = loadRecentChatContext(userId, personaName);

  return `${buildPersonaBlock(profile)}

## 最近聊天记录
${chatContext}

## 当前情况（重要）
你们刚才还在**持续聊天**。你刚回复完，但 ta 已经 ${Math.round(silenceMin)} 分钟没回你了。
${state.lastUserText ? `ta 上次说：「${state.lastUserText}」` : ""}
${state.lastBotText ? `你上次回复：「${state.lastBotText}」` : ""}

## 任务
结合聊天上下文和人设，自然地追问或关心一句，像恋人发现对方突然已读不回。
要有具体内容，不要空泛套话。必须发消息，不要 SKIP。

${buildOutputRules(false)}`;
}
