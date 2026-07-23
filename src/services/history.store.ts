import fs from "fs";
import path from "path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { persistPath } from "../util/persist.js";

const HISTORY_DIR = persistPath("data", "history");

/** 人设改名后合并旧 key 的历史 */
const PERSONA_ALIASES: Record<string, string[]> = {
  claude: ["克劳德", "夏以昼"],
  克劳德: ["claude", "夏以昼"],
  夏以昼: ["claude", "克劳德"],
};

export function getHistoryKeyAliases(key: string): string[] {
  const colon = key.indexOf(":");
  if (colon < 0) return [key];
  const userId = key.slice(0, colon);
  const persona = key.slice(colon + 1).toLowerCase();
  const aliases = PERSONA_ALIASES[persona] ?? [];
  return [key, ...aliases.map((a) => `${userId}:${a.toLowerCase()}`)];
}

function encodeKey(key: string): string {
  return Buffer.from(key, "utf-8").toString("base64url");
}

function decodeKey(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

function ensureDir(): void {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function filePathForKey(key: string): string {
  return path.join(HISTORY_DIR, `${encodeKey(key)}.json`);
}

function parseHistoryFile(key: string): MessageParam[] {
  ensureDir();
  const filePath = filePathForKey(key);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as MessageParam[];
    if (!Array.isArray(data)) return [];
    return data.filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    );
  } catch {
    return [];
  }
}

export function loadHistory(key: string): MessageParam[] {
  return parseHistoryFile(key);
}

/** 加载历史：合并当前人设与旧别名 key，避免改名后只读到新空档 */
export function loadHistoryWithFallback(key: string): MessageParam[] {
  const keys = getHistoryKeyAliases(key);
  const chunks: { k: string; data: MessageParam[] }[] = [];

  for (const k of keys) {
    const data = parseHistoryFile(k);
    if (data.length > 0) chunks.push({ k, data });
  }

  if (chunks.length === 0) return [];

  // 多个人设 key 都有记录时合并（按出现顺序去重），再写回当前 key
  const merged: MessageParam[] = [];
  const seen = new Set<string>();
  for (const { data } of chunks) {
    for (const m of data) {
      const sig = `${m.role}:${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      merged.push(m);
    }
  }

  const max = getMaxHistoryMessages();
  const trimmed = merged.length > max ? merged.slice(merged.length - max) : merged;

  const fromOld = chunks.some((c) => c.k !== key);
  if (fromOld || chunks[0]!.k !== key) {
    console.log(
      `[Memory] 合并历史 ${trimmed.length} 条 →「${key}」（来源: ${chunks.map((c) => `${c.k}:${c.data.length}`).join(", ")}）`,
    );
    saveHistory(key, trimmed);
    for (const { k } of chunks) {
      if (k !== key) deleteHistory(k);
    }
  } else {
    console.log(`[Memory] 从磁盘恢复 ${trimmed.length} 条历史 key=${key}`);
  }

  return trimmed;
}

export function saveHistory(key: string, messages: MessageParam[]): void {
  ensureDir();
  const filePath = filePathForKey(key);
  try {
    fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), "utf-8");
    console.log(`[Memory] 已保存 ${messages.length} 条历史 key=${key}`);
  } catch (err) {
    console.warn(`[History] 保存失败 ${key}:`, err instanceof Error ? err.message : err);
  }
}

export function deleteHistory(key: string): void {
  try {
    fs.unlinkSync(filePathForKey(key));
  } catch {
    /* 文件不存在 */
  }
}

export function deleteAllHistoryForUser(userId: string): void {
  ensureDir();
  const prefix = `${userId}:`;
  try {
    for (const file of fs.readdirSync(HISTORY_DIR)) {
      if (!file.endsWith(".json")) continue;
      const key = decodeKey(file.slice(0, -5));
      if (key.startsWith(prefix)) {
        fs.unlinkSync(path.join(HISTORY_DIR, file));
      }
    }
  } catch {
    /* ignore */
  }
}

export function countHistoryFiles(): number {
  try {
    ensureDir();
    return fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function getMaxHistoryMessages(): number {
  const n = Number(process.env["MEMORY_MAX_MESSAGES"] ?? "40");
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 40;
}
