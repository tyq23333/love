import type { PersonaProfile } from "./types.js";
import { generateSelfie } from "./photo-generator.js";
import { isSelfieEnabled } from "./selfie.config.js";

const SELFIE_TAG = /\[SELFIE:([^|\]]+)\|([^\]]+)\]/gi;

export async function processSelfieTags(
  text: string,
  profile: PersonaProfile,
): Promise<string> {
  if (!isSelfieEnabled(profile)) return text;

  const matches = [...text.matchAll(SELFIE_TAG)];
  if (matches.length === 0) return text;

  let result = text;
  for (const match of matches) {
    const location = match[1]?.trim() ?? "";
    const activity = match[2]?.trim() ?? "";
    console.log(`[Selfie] 生成自拍 scene=${location} activity=${activity}`);

    const url = await generateSelfie(profile, location, activity);
    if (url) {
      result = result.replace(match[0], url);
    } else {
      result = result.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  return result;
}
