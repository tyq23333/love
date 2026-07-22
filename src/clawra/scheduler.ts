import { CronJob } from "cron";
import type { IMAdapter } from "../adapters/base.adapter.js";
import type { ClawraProfile, WeeklySchedule, ScheduleEntry } from "./types.js";
import { parseCronExpression } from "./schedule.js";
import { generateMessage } from "./message-generator.js";
import { generateSelfie } from "./photo-generator.js";
import { splitMultiMessages, sleep, messageDelayMs } from "../services/reply.service.js";

interface ClawraSchedulerOptions {
  readonly profile: ClawraProfile;
  readonly schedule: WeeklySchedule;
  readonly adapters: readonly IMAdapter[];
  readonly targetChatId: string;
  readonly timezone: string;
}

export class ClawraScheduler {
  private readonly profile: ClawraProfile;
  private readonly schedule: WeeklySchedule;
  private readonly adapters: readonly IMAdapter[];
  private readonly targetChatId: string;
  private readonly timezone: string;

  private readonly jobs: CronJob[] = [];
  private lastLocation: string = "";
  private lastPhotoDate: string = "";

  constructor(options: ClawraSchedulerOptions) {
    this.profile = options.profile;
    this.schedule = options.schedule;
    this.adapters = options.adapters;
    this.targetChatId = options.targetChatId;
    this.timezone = options.timezone;
  }

  start(): void {
    this.createJobsForDayType(this.schedule.weekday, true);
    this.createJobsForDayType(this.schedule.weekend, false);
    console.log(
      `[ClawraScheduler] Started ${this.jobs.length} cron jobs (timezone: ${this.timezone})`,
    );
  }

  stop(): void {
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs.length = 0;
    console.log("[ClawraScheduler] All cron jobs stopped");
  }

  private createJobsForDayType(
    entries: readonly ScheduleEntry[],
    isWeekday: boolean,
  ): void {
    for (const entry of entries) {
      const cronExpr = parseCronExpression(entry.time, isWeekday);
      const job = CronJob.from({
        cronTime: cronExpr,
        onTick: async () => { await this.handleEntry(entry); },
        timeZone: this.timezone,
        start: true,
      });
      this.jobs.push(job);
    }
  }

  private async handleEntry(entry: ScheduleEntry): Promise<void> {
    console.log(
      `[ClawraScheduler] Triggered: ${entry.time} ${entry.activity} @ ${entry.location}`,
    );

    try {
      const text = await generateMessage(this.profile, entry);

      const today = new Date().toDateString();
      const isNewDay = today !== this.lastPhotoDate;
      const locationChanged = entry.location !== this.lastLocation;
      const shouldSendPhoto = entry.sendPhoto && (locationChanged || isNewDay);

      let imageUrl: string | undefined;
      if (shouldSendPhoto) {
        const url = await generateSelfie(
          this.profile,
          entry.location,
          entry.activity,
        );
        if (url) imageUrl = url;
      }

      this.lastLocation = entry.location;
      if (shouldSendPhoto) this.lastPhotoDate = today;

      await this.sendToAllAdapters(text, imageUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ClawraScheduler] Error handling entry ${entry.time}: ${message}`);
    }
  }

  private async sendToAllAdapters(
    text: string,
    imageUrl?: string,
  ): Promise<void> {
    const parts = splitMultiMessages(text);
    for (const adapter of this.adapters) {
      try {
        if (imageUrl) {
          await adapter.sendMessage({
            chatId: this.targetChatId,
            text: parts[0] ?? "",
            mediaUrl: imageUrl,
          });
          for (let i = 1; i < parts.length; i++) {
            await sleep(messageDelayMs());
            await adapter.sendMessage({ chatId: this.targetChatId, text: parts[i] });
          }
        } else {
          for (let i = 0; i < parts.length; i++) {
            if (i > 0) await sleep(messageDelayMs());
            await adapter.sendMessage({ chatId: this.targetChatId, text: parts[i] });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[ClawraScheduler] Failed to send via ${adapter.platform}: ${message}`,
        );
      }
    }
  }
}
