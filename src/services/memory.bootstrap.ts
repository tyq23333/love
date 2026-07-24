import fs from "fs";
import { persistPath, ensurePersistDir } from "../util/persist.js";

function encodeKey(key: string): string {
  return Buffer.from(key, "utf-8").toString("base64url");
}

/**
 * 一次性从环境变量导入记忆到 Volume。
 * Railway Variables 设置 MEMORY_BOOTSTRAP=<base64>，部署成功后删掉该变量。
 */
export function bootstrapMemoryFromEnv(): void {
  const b64 = process.env["MEMORY_BOOTSTRAP"]?.trim();
  if (!b64) return;

  try {
    const raw = Buffer.from(b64, "base64").toString("utf-8");
    const pack = JSON.parse(raw) as {
      key: string;
      history: unknown[];
      summary?: string;
    };
    if (!pack.key || !Array.isArray(pack.history)) {
      console.warn("[Memory] MEMORY_BOOTSTRAP 格式无效，已跳过");
      return;
    }

    ensurePersistDir("data", "history");
    ensurePersistDir("data", "summaries");

    const histPath = persistPath("data", "history", `${encodeKey(pack.key)}.json`);
    fs.writeFileSync(histPath, JSON.stringify(pack.history, null, 2), "utf-8");
    console.log(`[Memory] 已从 MEMORY_BOOTSTRAP 导入近期原文 ${pack.history.length} 条 → ${histPath}`);

    if (pack.summary?.trim()) {
      const sumPath = persistPath("data", "summaries", `${encodeKey(pack.key)}.txt`);
      fs.writeFileSync(sumPath, pack.summary.trim(), "utf-8");
      console.log(`[Memory] 已导入长期摘要 ${pack.summary.trim().length} 字 → ${sumPath}`);
    }

    console.log("[Memory] 导入完成。请到 Railway Variables 删除 MEMORY_BOOTSTRAP，避免重复写入。");
  } catch (err) {
    console.warn("[Memory] MEMORY_BOOTSTRAP 导入失败:", err instanceof Error ? err.message : err);
  }
}
