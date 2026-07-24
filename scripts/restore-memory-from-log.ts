/**
 * 从 logs/messages.jsonl 重建 data/history + data/summaries
 * 用法: npx tsx scripts/restore-memory-from-log.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(root, "logs", "messages.jsonl");
const HISTORY_DIR = path.join(root, "data", "history");
const SUMMARY_DIR = path.join(root, "data", "summaries");

const USER_ID = process.env["RESTORE_USER_ID"] ?? "o9cq800-MYmrLppkxRgHg3kOcvIQ@im.wechat";
const PERSONA = process.env["RESTORE_PERSONA"] ?? "克劳德";
const PERSONA_ALIASES = new Set(["克劳德", "claude", PERSONA.toLowerCase()]);
const MAX_RECENT = Number(process.env["MEMORY_MAX_MESSAGES"] ?? "40");

function encodeKey(key: string): string {
  return Buffer.from(key, "utf-8").toString("base64url");
}

interface LogEntry {
  timestamp: string;
  userId: string;
  personaName: string;
  text: string;
  role?: "user" | "assistant";
}

function loadEntries(): LogEntry[] {
  const lines = fs.readFileSync(LOG, "utf-8").trim().split(/\n/).filter(Boolean);
  const out: LogEntry[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as LogEntry;
      if (e.userId !== USER_ID) continue;
      if (!PERSONA_ALIASES.has(e.personaName) && !PERSONA_ALIASES.has(e.personaName.toLowerCase())) {
        continue;
      }
      out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}

function toMessages(entries: LogEntry[]): { role: "user" | "assistant"; content: string }[] {
  return entries.map((e) => ({
    role: e.role === "assistant" ? "assistant" : "user",
    content: String(e.text ?? ""),
  }));
}

/** 无 API 时做规则摘要，便于上传云端 */
function buildRuleSummary(
  older: { role: string; content: string }[],
): string {
  const facts: string[] = [];
  const userLines = older.filter((m) => m.role === "user").map((m) => m.content.replace(/\s+/g, " ").trim());
  const unique = [...new Set(userLines.map((t) => t.slice(0, 80)))].slice(0, 40);

  facts.push(`- 用户微信对话人设为「${PERSONA}」，彼此以恋人/哥哥感相处`);
  facts.push(`- 日志中较早对话约 ${older.length} 条（已压缩，详见下列用户提过的事）`);
  for (const t of unique) {
    if (t.length < 2) continue;
    if (/^\/|^你好$|^在吗/.test(t)) continue;
    facts.push(`- 用户曾说：「${t}」`);
    if (facts.length >= 35) break;
  }
  return facts.join("\n");
}

async function maybeLlmSummary(
  older: { role: string; content: string }[],
  previous: string,
): Promise<string | null> {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) return null;
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: key });
    const transcript = older
      .map((m) => `${m.role === "user" ? "用户" : "你"}：${m.content.replace(/\n---\n/g, " / ").slice(0, 200)}`)
      .join("\n");
    const model = process.env["MEMORY_SUMMARY_MODEL"] ?? process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6";
    const res = await client.messages.create({
      model,
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: `把下面恋人微信旧对话压成长期记忆摘要（中文条目式，400字内）。保留称呼、喜好、约定、情绪与重要事实。只输出摘要。\n\n已有：\n${previous || "（无）"}\n\n旧对话：\n${transcript.slice(0, 12000)}`,
        },
      ],
    });
    const block = res.content[0];
    return block?.type === "text" ? block.text.trim() : null;
  } catch (err) {
    console.warn("LLM 摘要失败，改用规则摘要:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function main() {
  if (!fs.existsSync(LOG)) {
    throw new Error(`找不到 ${LOG}`);
  }
  const entries = loadEntries();
  if (entries.length === 0) {
    throw new Error("日志里没有匹配的消息");
  }

  const all = toMessages(entries);
  const maxRecent = Number.isFinite(MAX_RECENT) && MAX_RECENT > 0 ? Math.min(MAX_RECENT, 200) : 40;
  const recent = all.slice(-maxRecent);
  const older = all.slice(0, Math.max(0, all.length - maxRecent));

  const key = `${USER_ID}:${PERSONA.toLowerCase()}`;
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(SUMMARY_DIR, { recursive: true });

  const historyPath = path.join(HISTORY_DIR, `${encodeKey(key)}.json`);
  fs.writeFileSync(historyPath, JSON.stringify(recent, null, 2), "utf-8");
  console.log(`已写近期原文 ${recent.length} 条 → ${historyPath}`);

  let summary = buildRuleSummary(older.length ? older : all);
  const llm = await maybeLlmSummary(older.length ? older : all.slice(0, -maxRecent || all.length), "");
  if (llm) summary = llm;

  const summaryPath = path.join(SUMMARY_DIR, `${encodeKey(key)}.txt`);
  fs.writeFileSync(summaryPath, summary, "utf-8");
  console.log(`已写长期摘要 ${summary.length} 字 → ${summaryPath}`);
  console.log(`key=${key} 日志总条数=${all.length} 更早=${older.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
