import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { fal } from "@fal-ai/client";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(projectRoot, ".env") });

const mimeByExt: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("用法: npm run upload-ref -- 图片路径");
    console.error("示例: npm run upload-ref -- D:\\Pictures\\claude.jpg");
    process.exit(1);
  }

  const falKey = process.env["FAL_KEY"]?.trim();
  if (!falKey) {
    console.error("请先在 .env 里填写 FAL_KEY");
    process.exit(1);
  }

  const absPath = path.resolve(inputPath);
  if (!fs.existsSync(absPath)) {
    console.error(`找不到文件: ${absPath}`);
    process.exit(1);
  }

  const ext = path.extname(absPath).toLowerCase();
  const contentType = mimeByExt[ext];
  if (!contentType) {
    console.error("仅支持 jpg / jpeg / png / webp / gif");
    process.exit(1);
  }

  fal.config({ credentials: falKey });

  const buffer = fs.readFileSync(absPath);
  const fileName = path.basename(absPath);
  const file = new File([buffer], fileName, { type: contentType });

  console.log(`正在上传到 fal CDN: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
  const url = await fal.storage.upload(file);

  console.log("\n上传成功，参考图 URL：");
  console.log(url);
  console.log("\n把下面这行复制到 .env：");
  console.log(`SELFIE_REFERENCE_URL=${url}`);
}

main().catch((err) => {
  console.error("上传失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
