import Anthropic from "@anthropic-ai/sdk";
import HttpsProxyAgent from "https-proxy-agent";
import { anthropicProxyUrl } from "../util/proxy.js";
import type { ClawraProfile, ScheduleEntry, MessageType } from "./types.js";
import { buildTextSystemPrompt } from "./profile.js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 256;
const RETRY_DELAYS_MS = [500, 1000] as const;

const FALLBACK_TEMPLATES: Readonly<Record<MessageType, readonly string[]>> = {
  greeting: ["早安~ 今天也要加油哦！", "起床啦，新的一天开始了~", "早上好呀，昨晚睡得好吗？"],
  meal: ["该吃饭啦，别忘了~", "吃饭时间到了，好好吃饭哦", "记得吃饭呀，身体最重要"],
  activity: ["刚换了个地方，跟你说一声~", "在新地方感觉不错诶", "到了新地方，有点兴奋~"],
  goodnight: ["要睡觉了，晚安~", "好困哦，先去睡了，晚安", "睡了哦，做个好梦~"],
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const proxyUrl = anthropicProxyUrl();
    client = new Anthropic({
      apiKey: process.env["ANTHROPIC_API_KEY"],
      httpAgent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
    });
  }
  return client;
}

function pickFallback(messageType: MessageType): string {
  const templates = FALLBACK_TEMPLATES[messageType];
  const index = Math.floor(Math.random() * templates.length);
  return templates[index] ?? templates[0]!;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text block in LLM response");
  }
  return textBlock.text.trim();
}

export async function generateMessage(
  profile: ClawraProfile,
  entry: ScheduleEntry,
  context?: string,
): Promise<string> {
  const systemPrompt = buildTextSystemPrompt(profile);

  const userPrompt = [
    `现在是${entry.time}，你正在${entry.location}，${entry.activity}。`,
    `提示：${entry.promptHint}`,
    context ? `背景：${context}` : "",
    "发一条简短的微信给对方，符合你的说话风格，不超过两句话。",
  ]
    .filter(Boolean)
    .join("\n");

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt);
    } catch (err) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      console.warn(
        `[MessageGenerator] Attempt ${attempt + 1} failed, retrying in ${delay}ms:`,
        err instanceof Error ? err.message : String(err),
      );
      await sleep(delay);
    }
  }

  console.warn(
    `[MessageGenerator] All attempts failed, using fallback for type: ${entry.messageType}`,
  );
  return pickFallback(entry.messageType);
}
