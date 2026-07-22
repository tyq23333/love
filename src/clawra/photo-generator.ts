import axios from "axios";
import type { PersonaProfile } from "./types.js";
import { buildSelfiePrompt } from "./profile.js";
import { getSelfieReferenceUrls, getFalModelEndpoint, getFalModelId } from "./selfie.config.js";
import { anthropicProxyUrl, axiosDirect } from "../util/proxy.js";
import HttpsProxyAgent from "https-proxy-agent";

const TIMEOUT_MS = 180_000;

interface FalApiResponse {
  images: Array<{ url: string }>;
}

function buildFalPayload(
  modelId: string,
  referenceUrls: readonly string[],
  prompt: string,
): Record<string, unknown> {
  const base = { prompt, num_images: 1, output_format: "jpeg" as const };

  if (modelId.includes("flux-2")) {
    return {
      prompt,
      image_urls: [...referenceUrls],
      output_format: "jpeg",
      image_size: "auto",
      safety_tolerance: "3",
    };
  }

  if (modelId.includes("kontext/multi")) {
    return {
      ...base,
      image_urls: [...referenceUrls],
      guidance_scale: 3.5,
      safety_tolerance: "2",
    };
  }

  if (modelId.includes("kontext")) {
    return {
      ...base,
      image_url: referenceUrls[0],
      guidance_scale: 3.5,
      safety_tolerance: "2",
    };
  }

  if (modelId.includes("grok-imagine")) {
    return {
      ...base,
      ...(referenceUrls.length > 1
        ? { image_urls: [...referenceUrls] }
        : { image_url: referenceUrls[0] }),
      resolution: "2k",
      aspect_ratio: "auto",
    };
  }

  if (referenceUrls.length > 1) {
    return { ...base, image_urls: [...referenceUrls] };
  }

  return { ...base, image_url: referenceUrls[0] };
}

export async function generateSelfie(
  profile: PersonaProfile,
  location: string,
  activity: string,
): Promise<string | null> {
  const falKey = process.env["FAL_KEY"];
  if (!falKey) {
    console.warn("[PhotoGenerator] FAL_KEY not set, skipping photo generation");
    return null;
  }

  const referenceUrls = getSelfieReferenceUrls(profile);
  if (referenceUrls.length === 0) {
    console.warn("[PhotoGenerator] 未配置参考脸图（SELFIE_REFERENCE_URL / SELFIE_REFERENCE_URLS）");
    return null;
  }

  const modelId = getFalModelId();
  const endpoint = getFalModelEndpoint();
  const prompt = buildSelfiePrompt(profile, location, activity, referenceUrls.length, modelId);
  const payload = buildFalPayload(modelId, referenceUrls, prompt);

  try {
    console.log(
      `[PhotoGenerator] model=${modelId} refs=${referenceUrls.length} scene=${location}`,
    );
    const proxyUrl = anthropicProxyUrl();
    const response = await axios.post<FalApiResponse>(endpoint, payload, {
      ...axiosDirect,
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      timeout: TIMEOUT_MS,
      ...(proxyUrl ? { httpAgent: new HttpsProxyAgent(proxyUrl), httpsAgent: new HttpsProxyAgent(proxyUrl) } : {}),
    });

    const imageUrl = response.data?.images?.[0]?.url;
    if (!imageUrl) {
      console.warn("[PhotoGenerator] No image URL in fal.ai response");
      return null;
    }

    return imageUrl;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[PhotoGenerator] Failed to generate selfie: ${message}`);
    return null;
  }
}
