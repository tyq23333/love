import axios from "axios";
import crypto from "crypto";
import type { IncomingImage } from "./base.adapter.js";
import { axiosDirect } from "../util/proxy.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface WeChatImageItem {
  media?: CdnMedia;
  aeskey?: string;
  media_id?: string;
  url?: string;
}

function isValidImageBuffer(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return true;
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return true;
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF") return true;
  return false;
}

function detectMediaType(buffer: Buffer): IncomingImage["mediaType"] {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  return "image/webp";
}

/** 解析微信图片 AES 密钥（image_item.aeskey 优先） */
export function resolveImageAesKey(imageItem: WeChatImageItem): Buffer {
  if (imageItem.aeskey && /^[0-9a-f]{32}$/i.test(imageItem.aeskey)) {
    return Buffer.from(imageItem.aeskey, "hex");
  }

  const mediaKey = imageItem.media?.aes_key;
  if (!mediaKey) throw new Error("缺少 aes_key");

  const decoded = Buffer.from(mediaKey, "base64");
  if (decoded.length === 16) return decoded;

  const asHex = decoded.toString("utf-8");
  if (/^[0-9a-f]{32}$/i.test(asHex)) {
    return Buffer.from(asHex, "hex");
  }

  if (decoded.length >= 16) return decoded.subarray(0, 16);
  throw new Error("无法解析 aes_key");
}

function decryptAesEcb(encrypted: Buffer, keyBuf: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", keyBuf, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/** 从微信 CDN 下载并解密图片 */
export async function downloadWeChatImage(
  imageItem: WeChatImageItem,
): Promise<IncomingImage | null> {
  const param = imageItem.media?.encrypt_query_param;
  if (!param) {
    console.warn("[WeChat-CDN] image_item 缺少 media.encrypt_query_param");
    return null;
  }

  try {
    const keyBuf = resolveImageAesKey(imageItem);
    const url = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(param)}`;
    console.log(`[WeChat-CDN] 从 CDN 下载图片...`);

    const res = await axios.get<ArrayBuffer>(url, {
      ...axiosDirect,
      responseType: "arraybuffer",
      timeout: 60_000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (res.status !== 200) {
      console.warn(`[WeChat-CDN] CDN 下载失败 HTTP ${res.status}`);
      return null;
    }

    const encrypted = Buffer.from(res.data);
    const buffer = decryptAesEcb(encrypted, keyBuf);

    if (!isValidImageBuffer(buffer)) {
      console.warn(`[WeChat-CDN] 解密后不是有效图片 size=${buffer.length}`);
      return null;
    }

    console.log(`[WeChat-CDN] 图片解密成功 size=${buffer.length} type=${detectMediaType(buffer)}`);
    return {
      data: buffer.toString("base64"),
      mediaType: detectMediaType(buffer),
    };
  } catch (err) {
    console.warn("[WeChat-CDN] 下载/解密失败:", err instanceof Error ? err.message : err);
    return null;
  }
}
