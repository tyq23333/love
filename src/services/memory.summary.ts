import fs from "fs";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { persistPath, ensurePersistDir } from "../util/persist.js";
import { getHistoryKeyAliases } from "./history.store.js";
import { createCompanionClient, companionModel } from "../companion/client.util.js";

const SUMMARY_DIR = persistPath("data", "summaries");

function encodeKey(key: string): string {
  return Buffer.from(key, "utf-8").toString("base64url");
}

function filePathForKey(key: string): string {
  return `${SUMMARY_DIR}/${encodeKey(key)}.txt`;
}

export function isMemorySummaryEnabled(): boolean {
  return process.env["MEMORY_SUMMARY_ENABLED"] !== "false";
}

function summaryModel(): string {
  return (
    process.env["MEMORY_SUMMARY_MODEL"]?.trim() ||
    process.env["ANTHROPIC_MODEL"] ||
    companionModel()
  );
}

export function loadMemorySummary(key: string): string {
  ensurePersistDir("data", "summaries");
  for (const k of getHistoryKeyAliases(key)) {
    try {
      const text = fs.readFileSync(filePathForKey(k), "utf-8").trim();
      if (text) {
        if (k !== key) {
          saveMemorySummary(key, text);
          deleteMemorySummary(k);
        }
        return text;
      }
    } catch {
      /* missing */
    }
  }
  return "";
}

export function saveMemorySummary(key: string, summary: string): void {
  ensurePersistDir("data", "summaries");
  const cleaned = summary.trim();
  if (!cleaned) return;
  try {
    fs.writeFileSync(filePathForKey(key), cleaned, "utf-8");
    console.log(`[Memory] 已更新长期摘要 key=${key} chars=${cleaned.length}`);
  } catch (err) {
    console.warn("[Memory] 保存摘要失败:", err instanceof Error ? err.message : err);
  }
}

export function deleteMemorySummary(key: string): void {
  try {
    fs.unlinkSync(filePathForKey(key));
  } catch {
    /* ignore */
  }
}

export function deleteAllSummariesForUser(userId: string): void {
  ensurePersistDir("data", "summaries");
  const prefix = `${userId}:`;
  try {
    for (const file of fs.readdirSync(SUMMARY_DIR)) {
      if (!file.endsWith(".txt")) continue;
      const encoded = file.slice(0, -4);
      const key = Buffer.from(encoded, "base64url").toString("utf-8");
      if (key.startsWith(prefix)) {
        fs.unlinkSync(`${SUMMARY_DIR}/${file}`);
      }
    }
  } catch {
    /* ignore */
  }
}

export function formatSummaryForPrompt(summary: string): string {
  if (!summary.trim()) return "";
  return `\n\n## 长期记忆摘要（比近期原文更早的事，必须遵守，不要遗忘）\n${summary.trim()}\n`;
}

function formatMessagesForSummary(messages: MessageParam[]): string {
  return messages
    .map((m) => {
      const who = m.role === "user" ? "用户" : "你";
      const text =
        typeof m.content === "string"
          ? m.content.replace(/\n---\n/g, " / ").replace(/\s+/g, " ").trim()
          : "[非文本]";
      return `${who}：${text.slice(0, 300)}`;
    })
    .join("\n");
}

/**
 * 把即将丢掉的旧对话压进长期摘要。
 * 失败时保留旧摘要，不阻塞主回复。
 */
export async function compactOverflowIntoSummary(
  key: string,
  overflow: MessageParam[],
): Promise<string> {
  if (!isMemorySummaryEnabled() || overflow.length === 0) {
    return loadMemorySummary(key);
  }

  const previous = loadMemorySummary(key);
  const transcript = formatMessagesForSummary(overflow);

  const prompt = `你在维护一段恋人微信对话的「长期记忆摘要」。
把下面「即将忘掉的旧对话」合并进已有摘要，输出更新后的完整摘要（不要解释、不要标题）。

要求：
- 用中文，条目式、简短，控制在 400 字以内
- 保留：称呼/昵称、喜好忌讳、重要约定、情绪与关系进展、反复提到的事、身体/行程等关键事实
- 删掉闲聊寒暄、重复内容、过期的一次性安排
- 用第三人称写「用户」「对方（你扮演的恋人）」也可，保持清晰即可

## 已有摘要
${previous || "（暂无）"}

## 即将忘掉的旧对话
${transcript}`;

  try {
    const client = createCompanionClient();
    const response = await client.messages.create({
      model: summaryModel(),
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const block = response.content[0];
    const next = block?.type === "text" ? block.text.trim() : "";
    if (next) {
      saveMemorySummary(key, next);
      return next;
    }
  } catch (err) {
    console.warn("[Memory] 摘要更新失败:", err instanceof Error ? err.message : err);
  }
  return previous;
}
