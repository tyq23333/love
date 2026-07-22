import { appendFileSync, existsSync, readFileSync } from "fs";
import { persistPath, ensurePersistDir } from "../util/persist.js";

const LOG_PATH = persistPath("logs", "messages.jsonl");

ensurePersistDir("logs");

export interface MessageLog {
  timestamp: string;
  source: string;
  userId: string;
  personaName: string;
  text: string;
  role?: "user" | "assistant";
}

export function logMessage(entry: MessageLog): void {
  try {
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // 日志写入失败不影响主流程
  }
}

/** 从历史日志中提取用户近期发言，用于重启后补全记忆 */
export function loadRecentUserTexts(
  userId: string,
  personaNames: string[],
  limit = 10,
): string[] {
  if (!existsSync(LOG_PATH)) return [];
  const names = new Set(personaNames.map((n) => n.toLowerCase()));
  const texts: string[] = [];
  try {
    const lines = readFileSync(LOG_PATH, "utf-8").trim().split("\n").reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as MessageLog;
        if (entry.userId !== userId) continue;
        if (!names.has(entry.personaName.toLowerCase())) continue;
        if (entry.role === "assistant") continue;
        if (entry.text?.trim()) texts.push(entry.text.trim());
        if (texts.length >= limit) break;
      } catch {
        /* skip bad line */
      }
    }
  } catch {
    return [];
  }
  return texts.reverse();
}
