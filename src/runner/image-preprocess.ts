import sharp from "sharp";
import type { IncomingImage } from "../adapters/base.adapter.js";

const MAX_LONG_EDGE = 1568;
const MIN_LONG_EDGE = 200;

/** 规范化分辨率/方向，提升 Claude 识图准确度 */
export async function prepareImagesForVision(images: IncomingImage[]): Promise<IncomingImage[]> {
  const prepared: IncomingImage[] = [];

  for (const img of images) {
    try {
      const input = Buffer.from(img.data, "base64");
      const meta = await sharp(input).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      const longEdge = Math.max(width, height);

      if (longEdge > 0 && longEdge < MIN_LONG_EDGE) {
        console.warn(`[Vision] 图片分辨率偏低 ${width}x${height}，识图可能不准`);
      }

      let pipeline = sharp(input).rotate();

      if (longEdge > MAX_LONG_EDGE) {
        pipeline = pipeline.resize({
          width: width >= height ? MAX_LONG_EDGE : undefined,
          height: height > width ? MAX_LONG_EDGE : undefined,
          fit: "inside",
          withoutEnlargement: true,
        });
      }

      const hasAlpha = meta.hasAlpha === true;
      let output: Buffer;
      let mediaType: IncomingImage["mediaType"];

      if (hasAlpha) {
        output = await pipeline.png({ compressionLevel: 6 }).toBuffer();
        mediaType = "image/png";
      } else {
        output = await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
        mediaType = "image/jpeg";
      }

      const outMeta = await sharp(output).metadata();
      console.log(
        `[Vision] 预处理 ${width}x${height} → ${outMeta.width}x${outMeta.height} ${mediaType} ${output.length}B`,
      );

      prepared.push({
        data: output.toString("base64"),
        mediaType,
      });
    } catch (err) {
      console.warn(
        `[Vision] 预处理失败，使用原图:`,
        err instanceof Error ? err.message : err,
      );
      prepared.push(img);
    }
  }

  return prepared;
}
