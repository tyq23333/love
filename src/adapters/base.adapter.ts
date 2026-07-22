export interface IncomingImage {
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface IncomingMessage {
  /** 平台用户唯一 ID（Telegram userId / 钉钉 staffId / 微信 wxid） */
  userId: string;
  /** 会话 ID（Telegram chatId / 钉钉 conversationId / 微信 wxid） */
  chatId: string;
  /** 消息内容 */
  text: string;
  /** 用户附带的图片（base64） */
  images?: IncomingImage[];
  platform: "telegram" | "dingtalk" | "wechat";
  timestamp: Date;
}

export interface OutgoingMessage {
  chatId: string;
  text: string;
  mediaUrl?: string;
  fallbackText?: string;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface IMAdapter {
  readonly platform: "telegram" | "dingtalk" | "wechat";
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(msg: OutgoingMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
