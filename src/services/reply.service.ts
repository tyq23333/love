/** 将 Claude 回复拆成多条微信消息 */
const MSG_TAG_RE = /\[msg\]\s*([\s\S]*?)\s*\[\/msg\]/gi;

/** 去掉残留的 [msg] 标签 */
export function stripMsgTags(text: string): string {
  return text
    .replace(/\[msg\]\s*([\s\S]*?)\s*\[\/msg\]/gi, (_match, content: string) => content.trim())
    .replace(/\[msg\]|\[\/msg\]/gi, "")
    .trim();
}

/** 按分隔符拆成多条消息（支持 --- 与 [msg] 混用，保留顺序） */
export function splitMultiMessages(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 行内的「 --- 」也视为分隔（模型常输出在同一行）
  let normalized = trimmed.replace(/\s---\s/g, "\n---\n");

  // [msg]...[/msg] 转为分段，与 --- 统一处理
  normalized = normalized.replace(MSG_TAG_RE, (_match, content: string) => {
    const inner = content.trim();
    return inner ? `\n---\n${inner}\n---\n` : "";
  });

  const parts = normalized
    .split(/\n---\n/)
    .map((s) => stripMsgTags(s))
    .filter(Boolean);

  if (parts.length > 0) return capMultiMessages(parts);
  const single = stripMsgTags(trimmed);
  return single ? [single] : [];
}

/** 微信单轮最多发几条，超出合并（防 prepare failed 限流） */
export function maxReplyParts(): number {
  const n = Number(process.env["MESSAGE_MAX_PARTS"] ?? "3");
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 6) : 3;
}

export function capMultiMessages(parts: string[], max = maxReplyParts()): string[] {
  if (parts.length <= max) return parts;
  const head = parts.slice(0, max - 1);
  const tail = parts.slice(max - 1).join("，");
  if (tail) head.push(tail);
  console.log(`[Reply] 消息 ${parts.length} 条过多，合并为 ${head.length} 条`);
  return head;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 多条消息之间的间隔（毫秒），模拟真人打字 */
export function messageDelayMs(partIndex = 0, platform?: string): number {
  const base = Number(process.env["MESSAGE_DELAY_MS"] ?? "800");
  const jitter = Math.random() * 400;
  let delay = base + jitter;
  if (platform === "wechat" && partIndex > 0) {
    delay = Math.max(delay, 1200 + partIndex * 300);
  }
  return delay;
}

export function buildMultiMessagePromptHint(): string {
  return `
## 发消息方式（重要）
像真人发微信：**最多 2～3 条**短消息，每条一句，不要超过 3 条。
用单独一行的 --- 分隔，例如：
在的~
---
怎么啦？

**禁止**超过 3 条；**禁止**用 [msg] 标签（只用 ---）。`;
}
