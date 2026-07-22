import type Anthropic from "@anthropic-ai/sdk";
import type { IncomingImage } from "../adapters/base.adapter.js";
import { buildAnalysisMessageContent } from "./message-content.js";

const PREFLIGHT_MAX_TOKENS = 600;

function extractText(content: Anthropic.Message): string {
  return content.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** 先客观识图，再把结果注入主对话，减少看错/瞎猜 */
export async function preflightImageAnalysis(
  client: Anthropic,
  model: string,
  images: IncomingImage[],
  userText: string,
): Promise<string | null> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: PREFLIGHT_MAX_TOKENS,
      system:
        "你是图像识别助手。只描述图片里**实际可见**的内容，不评价、不猜测、不扮演角色。看不清就写「看不清」。用中文，简洁分条。",
      messages: [
        {
          role: "user",
          content: buildAnalysisMessageContent(images, userText),
        },
      ],
    });

    const text = extractText(response);
    if (!text) {
      console.warn("[Vision] 预分析无文本输出");
      return null;
    }

    console.log(`[Vision] 预分析完成 len=${text.length}`);
    return text;
  } catch (err) {
    console.warn(
      "[Vision] 预分析失败，跳过:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function isVisionPreflightEnabled(): boolean {
  return process.env["VISION_PREFLIGHT"] !== "false";
}
