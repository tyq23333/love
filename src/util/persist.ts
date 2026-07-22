import fs from "fs";
import path from "path";

/**
 * 持久化根目录：云端挂载卷时设 PERSIST_DIR（如 /data）。
 * 未设置时退回 process.cwd()，与本地开发行为一致。
 */
export function getPersistRoot(): string {
  const dir = process.env["PERSIST_DIR"]?.trim();
  return dir ? path.resolve(dir) : process.cwd();
}

export function persistPath(...parts: string[]): string {
  return path.join(getPersistRoot(), ...parts);
}

export function ensurePersistDir(...parts: string[]): string {
  const dir = persistPath(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
