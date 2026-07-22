import { createServer, type IncomingMessage as NodeRequest, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import axios from "axios";
import type { IMAdapter, IncomingMessage, OutgoingMessage, MessageHandler } from "./base.adapter.js";

interface DingTalkConfig {
  appKey: string;
  appSecret: string;
  agentId: string;
  webhookSecret: string;
  port: number;
}

interface DingTalkToken {
  accessToken: string;
  expiresAt: number;
}

export class DingTalkAdapter implements IMAdapter {
  readonly platform = "dingtalk" as const;
  private handler?: MessageHandler;
  private tokenCache?: DingTalkToken;
  private server?: ReturnType<typeof createServer>;

  constructor(private readonly config: DingTalkConfig) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    const token = await this.getAccessToken();
    const [, conversationId, userId] = msg.chatId.split("_");

    await axios.post(
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      {
        robotCode: this.config.appKey,
        userIds: [userId],
        msgKey: "sampleMarkdown",
        msgParam: JSON.stringify({
          title: "Claude",
          text: msg.text,
        }),
      },
      {
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
      },
    );

    void conversationId;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.accessToken;
    }

    const res = await axios.post<{ accessToken: string; expireIn: number }>(
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      { appKey: this.config.appKey, appSecret: this.config.appSecret },
      { headers: { "Content-Type": "application/json" } },
    );

    this.tokenCache = {
      accessToken: res.data.accessToken,
      expiresAt: now + res.data.expireIn * 1000,
    };

    return this.tokenCache.accessToken;
  }

  private verifySignature(timestamp: string, sign: string): boolean {
    const expected = createHmac("sha256", this.config.webhookSecret)
      .update(`${timestamp}\n${this.config.webhookSecret}`)
      .digest("base64");
    return expected === sign;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, () => {
        console.log(`[DingTalk] Webhook server listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
    console.log("[DingTalk] Webhook server stopped");
  }

  private async handleRequest(req: NodeRequest, res: ServerResponse): Promise<void> {
    if (req.url !== "/dingtalk/webhook" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }

    const body = await this.readBody(req);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }

    const timestamp = String(payload["timestamp"] ?? "");
    const sign = String(payload["sign"] ?? "");
    if (!this.verifySignature(timestamp, sign)) {
      console.warn("[DingTalk] Signature verification failed");
      res.writeHead(401).end("Unauthorized");
      return;
    }

    const text = this.extractText(payload);
    const userId = String((payload["senderStaffId"] as string | undefined) ?? "unknown");
    const conversationId = String(
      (payload["conversationId"] as string | undefined) ?? "unknown",
    );

    if (text && this.handler) {
      await this.handler({
        userId,
        chatId: `dingtalk_${conversationId}_${userId}`,
        text,
        platform: "dingtalk",
        timestamp: new Date(),
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ msgtype: "empty" }),
    );
  }

  private extractText(payload: Record<string, unknown>): string {
    const text = payload["text"] as { content?: string } | undefined;
    if (text?.content) return text.content.trim();
    return String(payload["content"] ?? "");
  }

  private readBody(req: NodeRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }
}
