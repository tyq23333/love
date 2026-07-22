/** 记录最近用过的表情包，避免连续重复 */
const RECENT_MAX = 5;
const recentByKey = new Map<string, string[]>();

function key(userId: string, personaName: string): string {
  return `${userId}:${personaName.toLowerCase()}`;
}

export function recordStickersUsed(
  userId: string,
  personaName: string,
  names: readonly string[],
): void {
  if (!names.length) return;
  const k = key(userId, personaName);
  const prev = recentByKey.get(k) ?? [];
  recentByKey.set(k, [...prev, ...names].slice(-RECENT_MAX));
}

export function buildStickerAvoidHint(userId: string, personaName: string): string {
  const recent = recentByKey.get(key(userId, personaName));
  if (!recent?.length) return "";
  const last = recent[recent.length - 1];
  const avoid = [...new Set(recent.slice(-3))];
  return `\n\n## 表情包轮换\n你最近用过：${avoid.map((n) => `[sticker:${n}]`).join("、")}。本条请**换别的**，尤其不要再用 [sticker:${last}]。`;
}
