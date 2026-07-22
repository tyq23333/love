import type { PersonaProfile } from "./types.js";

const MAX_REFERENCE_IMAGES = 3;
const DEFAULT_FAL_MODEL = "xai/grok-imagine-image/edit";

function parseUrlList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,，\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, MAX_REFERENCE_IMAGES);
}

/** 参考图列表：优先 SELFIE_REFERENCE_URLS，其次 SELFIE_REFERENCE_URL / personas.json（最多 3 张） */
export function getSelfieReferenceUrls(profile: PersonaProfile): string[] {
  const fromEnvList = parseUrlList(process.env["SELFIE_REFERENCE_URLS"]);
  if (fromEnvList.length > 0) return fromEnvList;

  const single =
    process.env["SELFIE_REFERENCE_URL"]?.trim() ?? profile.selfie.referenceImageUrl?.trim();
  return single ? [single] : [];
}

export function getSelfieReferenceUrl(profile: PersonaProfile): string | undefined {
  return getSelfieReferenceUrls(profile)[0];
}

export function isSelfieEnabled(profile: PersonaProfile): boolean {
  return profile.selfie.enabled && getSelfieReferenceUrls(profile).length > 0;
}

/** fal 模型 endpoint，默认 Grok Imagine edit */
export function getFalModelEndpoint(): string {
  const raw = process.env["FAL_MODEL"]?.trim() || DEFAULT_FAL_MODEL;
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\/$/, "");
  }
  return `https://fal.run/${raw.replace(/^\/+/, "")}`;
}

export function getFalModelId(): string {
  const endpoint = getFalModelEndpoint();
  const match = /fal\.run\/(.+)$/i.exec(endpoint);
  return match?.[1] ?? DEFAULT_FAL_MODEL;
}
