export interface SelfieConfig {
  readonly enabled: boolean;
  readonly referenceImageUrl?: string;
}

export interface PersonaProfile {
  readonly name: string;
  readonly gender: string;
  readonly personality: readonly string[];
  readonly hobbies: readonly string[];
  readonly speakingStyle: string;
  readonly language: string;
  readonly replyPrefix: string;
  readonly contentPrefix: string;
  readonly nicknames: readonly string[];
  readonly selfie: SelfieConfig;
}

export interface PersonasConfig {
  readonly default: string;
  readonly personas: readonly PersonaProfile[];
}

export type MessageType = "greeting" | "meal" | "activity" | "goodnight";

export interface ScheduleEntry {
  readonly time: string;
  readonly activity: string;
  readonly location: string;
  readonly sendPhoto: boolean;
  readonly messageType: MessageType;
  readonly promptHint: string;
}

export interface WeeklySchedule {
  readonly weekday: readonly ScheduleEntry[];
  readonly weekend: readonly ScheduleEntry[];
}

export interface GeneratedMessage {
  readonly text: string;
  readonly imageUrl?: string;
}

export type ClawraProfile = PersonaProfile & { referenceImageUrl: string };
