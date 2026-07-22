import fs from "fs";
import path from "path";

export interface StickerSeriesMeta {
  name: string;
  style: "cute" | "cool" | string;
}

export interface StickerEntry {
  file: string;
  label?: string;
  series?: string;
  description?: string;
}

export interface StickerConfig {
  series?: Record<string, StickerSeriesMeta>;
  stickers: Record<string, StickerEntry>;
}

let stickerRegistry: Map<string, string> | null = null;
let stickerConfigCache: StickerConfig | null = null;

function loadStickerConfig(configPath?: string): StickerConfig {
  if (stickerConfigCache) return stickerConfigCache;
  const filePath = configPath ?? path.resolve(process.cwd(), "config/stickers.json");
  if (!fs.existsSync(filePath)) {
    stickerConfigCache = { stickers: {} };
    return stickerConfigCache;
  }
  stickerConfigCache = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StickerConfig;
  return stickerConfigCache;
}

/** 加载 config/stickers.json，返回 name → 绝对路径 */
export function loadStickers(configPath?: string): Map<string, string> {
  if (stickerRegistry) return stickerRegistry;

  const filePath = configPath ?? path.resolve(process.cwd(), "config/stickers.json");
  stickerRegistry = new Map();
  const raw = loadStickerConfig(configPath);
  const baseDir = path.dirname(filePath);

  if (!fs.existsSync(filePath)) {
    console.warn("[Stickers] 未找到 config/stickers.json，表情包功能不可用");
    return stickerRegistry;
  }

  for (const [name, entry] of Object.entries(raw.stickers ?? {})) {
    const absPath = path.resolve(baseDir, entry.file);
    if (fs.existsSync(absPath)) {
      stickerRegistry.set(name.toLowerCase(), absPath);
    } else {
      console.warn(`[Stickers] 文件不存在，跳过: ${name} → ${absPath}`);
    }
  }

  console.log(`[Stickers] 已加载 ${stickerRegistry.size} 个表情包`);
  return stickerRegistry;
}

export function getStickerPath(name: string): string | undefined {
  return loadStickers().get(name.toLowerCase());
}

export function getStickerNames(): string[] {
  return [...loadStickers().keys()];
}

function formatStickerLine(name: string, entry: StickerEntry): string {
  const label = entry.label ?? name;
  const desc = entry.description ?? "";
  return `[sticker:${name}]${label}${desc ? `(${desc})` : ""}`;
}

function buildCompactCatalog(config: StickerConfig): string {
  const bySeries = new Map<string, string[]>();

  for (const [name, entry] of Object.entries(config.stickers ?? {})) {
    const seriesId = entry.series ?? "other";
    const seriesName = config.series?.[seriesId]?.name ?? seriesId;
    const style = config.series?.[seriesId]?.style;
    const header = style === "cool" ? `${seriesName}/帅` : seriesName;
    const list = bySeries.get(header) ?? [];
    list.push(formatStickerLine(name, entry));
    bySeries.set(header, list);
  }

  return [...bySeries.entries()]
    .map(([header, items]) => `${header}: ${items.join(" ")}`)
    .join("\n");
}

export function buildStickerPromptHint(): string {
  const config = loadStickerConfig();
  if (Object.keys(config.stickers ?? {}).length === 0) return "";

  return `
## 表情
插入 [sticker:名]。3~4轮最多1次，勿连发同个，勿总用 huaixiao。宠→love/gandong/buyaozou 吃醋→dingzhini/qigugu 委屈→weiqukelian 严肃→yansu
${buildCompactCatalog(config)}`;
}

/** 从 Claude 回复中提取 [sticker:xxx] 标签 */
export function parseStickerTags(text: string): { stickers: string[]; cleanText: string } {
  const stickers: string[] = [];
  const cleanText = text
    .replace(/\[sticker:([^\]\s]+)\]/gi, (_, name: string) => {
      stickers.push(name.toLowerCase());
      return "";
    })
    .replace(/\[表情:([^\]\s]+)\]/g, (_, name: string) => {
      stickers.push(name.toLowerCase());
      return "";
    })
    .replace(/\n{3,}/g, "\n")
    .trim();

  return { stickers, cleanText };
}
