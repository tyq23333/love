import { readFileSync } from "fs";
import { z } from "zod";
import type { WeeklySchedule, ScheduleEntry } from "./types.js";

const MessageTypeSchema = z.enum(["greeting", "meal", "activity", "goodnight"]);

const ScheduleEntrySchema = z.object({
  time: z.string().regex(/^\d{2}:\d{2}$/, "time must be HH:MM format"),
  activity: z.string().min(1),
  location: z.string().min(1),
  sendPhoto: z.boolean(),
  messageType: MessageTypeSchema,
  promptHint: z.string().min(1),
});

const WeeklyScheduleSchema = z.object({
  weekday: z.array(ScheduleEntrySchema).min(1),
  weekend: z.array(ScheduleEntrySchema).min(1),
});

const scheduleCache = new Map<string, WeeklySchedule>();

export function loadSchedule(configPath: string): WeeklySchedule {
  const cached = scheduleCache.get(configPath);
  if (cached) return cached;

  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
  const parsed = WeeklyScheduleSchema.parse(raw);

  const schedule: WeeklySchedule = {
    weekday: Object.freeze(parsed.weekday.map(freezeEntry)),
    weekend: Object.freeze(parsed.weekend.map(freezeEntry)),
  };

  scheduleCache.set(configPath, schedule);
  return schedule;
}

export function getScheduleForDay(
  schedule: WeeklySchedule,
  date: Date,
): readonly ScheduleEntry[] {
  const dayOfWeek = date.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  return isWeekend ? schedule.weekend : schedule.weekday;
}

export function parseCronExpression(time: string, isWeekday: boolean): string {
  const [hourStr, minuteStr] = time.split(":");
  const hour = parseInt(hourStr ?? "0", 10);
  const minute = parseInt(minuteStr ?? "0", 10);

  if (isNaN(hour) || isNaN(minute)) {
    throw new Error(`Invalid time format: "${time}". Expected HH:MM`);
  }

  const dayRange = isWeekday ? "1-5" : "0,6";
  return `${minute} ${hour} * * ${dayRange}`;
}

function freezeEntry(entry: z.infer<typeof ScheduleEntrySchema>): ScheduleEntry {
  return Object.freeze({ ...entry });
}
