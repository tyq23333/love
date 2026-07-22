import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { IncomingImage } from "../adapters/base.adapter.js";

export type ImageMediaType = IncomingImage["mediaType"];

function imageBlocks(images: IncomingImage[]) {
  return images.map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: img.mediaType,
      data: img.data,
    },
  }));
}

/** 识图预分析：只要客观描述 */
export function buildAnalysisMessageContent(
  images: IncomingImage[],
  userText: string,
): MessageParam["content"] {
  const caption = userText.trim();
  return [
    ...imageBlocks(images),
    {
      type: "text",
      text: `用户附言：${caption || "（无文字，仅图片）"}

请只客观描述图片里**实际看到**的内容：
- 图片类型（自拍/人像/截图/食物/风景/宠物/表情包等）
- 人物（如有）：人数、性别感、发型、表情、姿势、穿着、配饰
- 环境与背景
- 图中可读文字（尽量逐字写出）
- 光线、构图等明显特征
看不清或不确定的写「不确定」，不要猜、不要评价。`,
    },
  ];
}

export function buildUserMessageContent(
  text: string,
  images?: IncomingImage[],
  options?: { hasPreflightAnalysis?: boolean },
): MessageParam["content"] {
  if (!images?.length) return text;

  const caption = text.trim();
  const preflightNote = options?.hasPreflightAnalysis
    ? "system 里已有「图片客观识别」，回复必须与之一致，禁止编造图里没有的东西。"
    : "先看清图里实际有什么，再回复；不确定就说看不清，不要猜。";

  return [
    ...imageBlocks(images),
    {
      type: "text",
      text:
        caption ||
        `恋人发来了一张图片。${preflightNote} 看清后用中文像恋人一样自然回应；若是 ta 的人像/自拍，根据你看到的具体细节反应，不要套模板。`,
    },
  ];
}

/** 持久化历史时用文字占位，避免存 base64 */
export function historyPlaceholder(text: string, images?: IncomingImage[]): string {
  if (!images?.length) return text;
  const caption = text.trim();
  return caption ? `[用户发来图片] ${caption}` : "[用户发来了一张图片]";
}

export function extractTextFromContent(content: MessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
