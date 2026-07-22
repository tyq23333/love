import type { IncomingImage } from "../adapters/base.adapter.js";

const TTL_MS = 30 * 60_000;

interface CachedImage {
  images: IncomingImage[];
  savedAt: number;
  lastDescription?: string;
}

const cache = new Map<string, CachedImage>();

function cacheKey(userId: string, personaName: string): string {
  return `${userId}:${personaName.toLowerCase()}`;
}

export function saveRecentImages(
  userId: string,
  personaName: string,
  images: IncomingImage[],
): void {
  if (!images.length) return;
  cache.set(cacheKey(userId, personaName), { images, savedAt: Date.now() });
}

export function saveImageDescription(
  userId: string,
  personaName: string,
  description: string,
): void {
  const key = cacheKey(userId, personaName);
  const entry = cache.get(key);
  if (entry) entry.lastDescription = description.slice(0, 800);
}

export function getRecentImages(
  userId: string,
  personaName: string,
): IncomingImage[] | undefined {
  const entry = cache.get(cacheKey(userId, personaName));
  if (!entry) return undefined;
  if (Date.now() - entry.savedAt > TTL_MS) {
    cache.delete(cacheKey(userId, personaName));
    return undefined;
  }
  return entry.images;
}

export function getRecentImageDescription(
  userId: string,
  personaName: string,
): string | undefined {
  const entry = cache.get(cacheKey(userId, personaName));
  if (!entry || Date.now() - entry.savedAt > TTL_MS) return undefined;
  return entry.lastDescription;
}

/** 用户在追问刚才发的图，但没有重新附带图片 */
export function isAskingAboutRecentImage(text: string): boolean {
  return /图片|照片|截图|刚才.*图|发.*什么|看清楚|加载|什么样|这张图|上面/.test(text);
}

export function looksLikeVisionRefusal(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^I (can'?t|cannot|notice|am unable|'m unable)/i.test(t)) return true;
  if (/unable to (view|see|process)|cannot (view|see)|content policy|sensitive content/i.test(t)) return true;
  // 大段纯英文 = 不像中文恋人回复
  const latin = (t.match(/[a-zA-Z]/g) ?? []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return latin > 40 && cjk < 5;
}

export function buildVisionRetryHint(personaName: string): string {
  return `

【识图重试·${personaName}】
图就在消息里。先看清楚，用中文像恋人当场看到的第一反应。
若是人像/自拍：说**这一张**里你注意到的具体细节，现想现说，**不要模板、不要套话、不要英文、不要拒答**。`;
}
