import Anthropic from "@anthropic-ai/sdk";
import HttpsProxyAgent from "https-proxy-agent";
import { anthropicProxyUrl } from "../util/proxy.js";

export function createCompanionClient(): Anthropic {
  const proxyUrl = anthropicProxyUrl();
  const baseUrlRaw = process.env["ANTHROPIC_BASE_URL"];
  const baseURL = baseUrlRaw?.replace(/\/v1\/?$/, "") || undefined;
  return new Anthropic({
    apiKey: process.env["ANTHROPIC_API_KEY"],
    baseURL,
    httpAgent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
  });
}

export function companionModel(): string {
  return process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6";
}

export function shouldSkipResponse(text: string): boolean {
  const first = text.trim().split("\n")[0]?.trim().toUpperCase() ?? "";
  return first === "SKIP" || first === "[SKIP]" || first === "不发";
}

export async function generateCompanionText(prompt: string, maxTokens = 300): Promise<string> {
  const client = createCompanionClient();
  const response = await client.messages.create({
    model: companionModel(),
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const content = response.content[0];
  return content.type === "text" ? content.text.trim() : "";
}

export function isQuietHour(now: Date, start: string, end: string): boolean {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = (sh ?? 0) * 60 + (sm ?? 0);
  const e = (eh ?? 0) * 60 + (em ?? 0);
  if (s <= e) return cur >= s && cur < e;
  return cur >= s || cur < e;
}
