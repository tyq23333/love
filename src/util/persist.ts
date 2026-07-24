import fs from "fs";
import path from "path";

/**
 * 持久化根目录优先级：
 * 1. PERSIST_DIR（手动指定，如 /data）
 * 2. RAILWAY_VOLUME_MOUNT_PATH（Railway 挂 Volume 时自动注入）
 * 3. process.cwd()（本地开发）
 */
export function getPersistRoot(): string {
  const dir =
    process.env["PERSIST_DIR"]?.trim() ||
    process.env["RAILWAY_VOLUME_MOUNT_PATH"]?.trim() ||
    "";
  return dir ? path.resolve(dir) : process.cwd();
}

export function persistPath(...parts: string[]): string {
  return path.join(getPersistRoot(), ...parts);
}

export function ensurePersistDir(...parts: string[]): string {
  const dir = parts.length ? persistPath(...parts) : getPersistRoot();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
