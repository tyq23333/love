import "dotenv/config";
import path from "path";
import fs from "fs";

import { SessionManager } from "./runner/session.manager.js";
import { PermissionManager } from "./permissions/permission.manager.js";
import { ClaudeRunner } from "./runner/claude.runner.js";
import { MessageRouter } from "./router/message.router.js";
import { TelegramAdapter } from "./adapters/telegram.adapter.js";
import { DingTalkAdapter } from "./adapters/dingtalk.adapter.js";
import { WeChatAdapter } from "./adapters/wechat.adapter.js";
import { loadPersonasConfig, getPersonaNames } from "./clawra/profile.js";
import { loadStickers } from "./services/sticker.service.js";
import { loadSchedule } from "./clawra/schedule.js";
import { ClawraScheduler } from "./clawra/scheduler.js";
import { AutonomousCompanion } from "./companion/autonomous.companion.js";
import { ConversationWatcher } from "./companion/conversation.watcher.js";
import type { IMAdapter } from "./adapters/base.adapter.js";
import { startHealthServer } from "./health.js";
import { getPersistRoot } from "./util/persist.js";
import { bootstrapMemoryFromEnv } from "./services/memory.bootstrap.js";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`缺少必要环境变量: ${key}`);
  return val;
}

async function main() {
  startHealthServer();
  const persistRoot = getPersistRoot();
  fs.mkdirSync(persistRoot, { recursive: true });
  console.log(`[Persist] 数据目录: ${persistRoot}`);
  if (process.env["RAILWAY_VOLUME_MOUNT_PATH"]) {
    console.log(`[Persist] Railway Volume: ${process.env["RAILWAY_VOLUME_MOUNT_PATH"]}`);
  }
  if (!process.env["PERSIST_DIR"]?.trim() && !process.env["RAILWAY_VOLUME_MOUNT_PATH"]?.trim()) {
    console.warn("[Persist] 未设置 PERSIST_DIR / Volume，重启后微信 Token 与聊天记录可能丢失");
  }
  bootstrapMemoryFromEnv();

  const personasPath = path.resolve(process.cwd(), "config/personas.json");
  const personasConfig = loadPersonasConfig(personasPath);
  const personaNames = getPersonaNames();
  const defaultPersona = personasConfig.default.toLowerCase();

  console.log(`[Personas] 已加载 ${personaNames.length} 个虚拟人：${personaNames.join("、")}`);
  console.log(`[Personas] 默认：${defaultPersona}`);

  loadStickers();

  const sessions = new SessionManager();

  const permissions = new PermissionManager({
    allowedUserIds: (process.env["ALLOWED_USER_IDS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowedTools: (process.env["ALLOWED_TOOLS"] ?? "Read,Glob,Grep")
      .split(",")
      .map((s) => s.trim()),
    workingDir: process.env["WORKING_DIR"] || process.cwd(),
  });

  const runner = new ClaudeRunner(sessions, permissions);
  const router = new MessageRouter(runner, permissions, personaNames, defaultPersona);

  const activeAdapters: IMAdapter[] = [];

  if (process.env["TELEGRAM_ENABLED"] !== "false" && process.env["TELEGRAM_BOT_TOKEN"]) {
    const telegram = new TelegramAdapter(requireEnv("TELEGRAM_BOT_TOKEN"));
    router.registerAdapter(telegram);
    activeAdapters.push(telegram);
  }

  if (process.env["DINGTALK_APP_KEY"]) {
    const dingtalk = new DingTalkAdapter({
      appKey: requireEnv("DINGTALK_APP_KEY"),
      appSecret: requireEnv("DINGTALK_APP_SECRET"),
      agentId: requireEnv("DINGTALK_AGENT_ID"),
      webhookSecret: requireEnv("DINGTALK_WEBHOOK_SECRET"),
      port: Number(process.env["DINGTALK_WEBHOOK_PORT"] ?? "3000"),
    });
    router.registerAdapter(dingtalk);
    activeAdapters.push(dingtalk);
  }

  if (process.env["WECHAT_ENABLED"] === "true") {
    const wechat = new WeChatAdapter();
    router.registerAdapter(wechat);
    activeAdapters.push(wechat);
  }

  if (activeAdapters.length === 0) {
    console.warn("未配置任何 IM 适配器，请检查 .env 文件");
    process.exit(1);
  }

  let scheduler: ClawraScheduler | null = null;
  let companion: AutonomousCompanion | null = null;
  let conversationWatcher: ConversationWatcher | null = null;

  const scheduleEnabled = process.env["CLAWRA_SCHEDULE_ENABLED"] === "true";
  if (scheduleEnabled) {
    const schedulePath = path.resolve(process.cwd(), "config/clawra-schedule.json");
    const schedule = loadSchedule(schedulePath);

    const { loadProfile } = await import("./clawra/profile.js");
    const profile = loadProfile("");

    const targetChatId = process.env["CLAWRA_TARGET_CHAT_ID"] ?? "";
    const timezone = process.env["CLAWRA_TIMEZONE"] ?? "Asia/Shanghai";

    if (!targetChatId) {
      console.warn("⚠️ CLAWRA_SCHEDULE_ENABLED=true 但未设置 CLAWRA_TARGET_CHAT_ID，调度器已跳过");
    } else {
      scheduler = new ClawraScheduler({
        profile,
        schedule,
        adapters: activeAdapters,
        targetChatId,
        timezone,
      });
    }
  }

  const companionEnabled = process.env["COMPANION_ENABLED"] === "true";
  if (companionEnabled) {
    const targetChatId = process.env["COMPANION_TARGET_CHAT_ID"] ?? process.env["CLAWRA_TARGET_CHAT_ID"] ?? "";
    if (!targetChatId) {
      console.warn("⚠️ COMPANION_ENABLED=true 但未设置 COMPANION_TARGET_CHAT_ID");
    } else {
      const persona = (process.env["COMPANION_PERSONA"] ?? defaultPersona).toLowerCase();
      companion = new AutonomousCompanion({
        adapters: activeAdapters,
        targetChatId,
        userId: targetChatId,
        personaName: persona,
        checkIntervalMin: Number(process.env["COMPANION_CHECK_INTERVAL_MIN"] ?? "20"),
        minIdleMin: Number(process.env["COMPANION_MIN_IDLE_MIN"] ?? "15"),
        quietStart: process.env["COMPANION_QUIET_START"] ?? "01:00",
        quietEnd: process.env["COMPANION_QUIET_END"] ?? "08:00",
      });

      conversationWatcher = new ConversationWatcher({
        adapters: activeAdapters,
        targetChatId,
        userId: targetChatId,
        personaName: persona,
        silenceMin: Number(process.env["CONVERSATION_SILENCE_MIN"] ?? "3"),
        checkIntervalSec: Number(process.env["CONVERSATION_CHECK_INTERVAL_SEC"] ?? "30"),
        quietStart: process.env["COMPANION_QUIET_START"] ?? "01:00",
        quietEnd: process.env["COMPANION_QUIET_END"] ?? "08:00",
      });
    }
  }

  const shutdown = async () => {
    console.log("\n正在关闭...");
    if (scheduler) scheduler.stop();
    if (companion) companion.stop();
    if (conversationWatcher) conversationWatcher.stop();
    await router.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (scheduler) {
    scheduler.start();
    console.log("定时消息调度已启动");
  }

  if (companion) {
    companion.start();
  }

  if (conversationWatcher) {
    conversationWatcher.start();
  }

  console.log("IM-Claude Bridge 已启动");
  await router.startAll();
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
