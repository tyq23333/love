import type { IMAdapter } from "../adapters/base.adapter.js";
import { splitMultiMessages, sleep, messageDelayMs } from "../services/reply.service.js";
import { parseStickerTags, getStickerPath } from "../services/sticker.service.js";

export async function sendPersonaMessages(
  adapters: readonly IMAdapter[],
  chatId: string,
  text: string,
  platform = "wechat",
): Promise<boolean> {
  const adapter = adapters.find((a) => a.platform === platform);
  if (!adapter) {
    console.warn(`[Send] 未找到 ${platform} 适配器`);
    return false;
  }

  const { stickers, cleanText } = parseStickerTags(text);

  for (const name of stickers) {
    const stickerPath = getStickerPath(name);
    if (stickerPath) {
      await adapter.sendMessage({
        chatId,
        text: "",
        mediaUrl: `file://${stickerPath}`,
        fallbackText: `[表情:${name}]`,
      });
      await sleep(messageDelayMs(0, platform));
    }
  }

  const parts = splitMultiMessages(cleanText || text);
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) await sleep(messageDelayMs(i, platform));
    await adapter.sendMessage({ chatId, text: parts[i] });
  }
  return true;
}
