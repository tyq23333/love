import axios, { type AxiosInstance } from "axios";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { IMAdapter, IncomingMessage, IncomingImage, OutgoingMessage, MessageHandler } from "./base.adapter.js";
import {
  downloadWeChatImage,
  type WeChatImageItem,
} from "./wechat-cdn.util.js";
import { axiosDirect } from "../util/proxy.js";
import { persistPath, ensurePersistDir, getPersistRoot } from "../util/persist.js";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.2";

function tokenFile(): string {
  return persistPath(".wechat-token");
}

function contextFile(): string {
  return persistPath(".wechat-context.json");
}

/** 旧版写在项目根目录的 token，部署后会丢；若 Volume 里没有则尝试迁移 */
function legacyTokenCandidates(): string[] {
  return [
    path.resolve(process.cwd(), ".wechat-token"),
    path.resolve("/app", ".wechat-token"),
  ];
}

function legacyContextCandidates(): string[] {
  return [
    path.resolve(process.cwd(), ".wechat-context.json"),
    path.resolve("/app", ".wechat-context.json"),
  ];
}

// ── API 类型 ──────────────────────────────────────────────────────────────────

interface MessageItem {
 type: number; // 1=文字, 2=图片, 3=语音, 4=文件, 5=视频
 create_time_ms?: number;
 msg_id?: string;
 text_item?: { text: string };
 image_item?: WeChatImageItem;
 voice_item?: { text?: string };
 ref_msg?: { title?: string; message_item?: MessageItem };
}

interface WeChatMessage {
 from_user_id: string; // xxx@im.wechat
 to_user_id: string; // xxx@im.bot
 message_type: number; // 1=用户消息, 2=bot消息
 message_state: number;
 context_token: string;
 item_list: MessageItem[];
}

interface GetUpdatesResponse {
 ret?: number;
 errcode?: number;
 errmsg?: string;
 msgs?: WeChatMessage[];
 get_updates_buf?: string;
 longpolling_timeout_ms?: number;
}

interface SendMessageResponse {
 ret?: number;
 errcode?: number;
 errmsg?: string;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class WeChatAdapter implements IMAdapter {
 readonly platform = "wechat" as const;

 private baseUrl = BASE_URL;
 private botToken: string | null = null;
 private handler?: MessageHandler;
 private polling = false;
 private updatesBuf = ""; // 游标，空串=从最新消息开始
 private stopResolve?: () => void;

 /** userId → 最新 context_token，用于回复消息 */
 private contextTokens = new Map<string, string>();
 /** 已处理过的消息key → 时间戳，防止重复处理（60秒窗口） */
 private seenMessageKeys = new Map<string, number>();
 private readonly DEDUP_WINDOW_MS = 60_000;
 /** 动态识别的 Bot ID (来自收到的消息的 to_user_id) */
 private botId: string | null = null;
 /** msg_id → 图片元数据，用于「引用回复」场景 */
 private readonly imageItemCache = new Map<string, WeChatImageItem>();
 private httpClient: AxiosInstance | null = null;

 private get http(): AxiosInstance {
  if (!this.httpClient) {
   this.httpClient = axios.create({
    ...axiosDirect,
    baseURL: this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`,
    headers: {
     "Content-Type": "application/json",
     "Authorization": `Bearer ${this.botToken}`,
     "AuthorizationType": "ilink_bot_token",
     "X-WECHAT-UIN": randomWechatUin(),
    },
    timeout: 40_000,
   });
  } else {
   this.httpClient.defaults.headers.common["Authorization"] = `Bearer ${this.botToken}`;
   this.httpClient.defaults.headers.common["X-WECHAT-UIN"] = randomWechatUin();
  }
  return this.httpClient;
 }

 // ── 公共接口 ───────────────────────────────────────────────────────────────

 onMessage(handler: MessageHandler): void {
 this.handler = handler;
 }

 async start(): Promise {
 console.log("[WeChat] 正在启动微信适配器...");
 console.log(`[WeChat] Token 路径: ${tokenFile()} (persist=${getPersistRoot()})`);

 this.botToken = this.loadToken();
 if (!this.botToken) {
 try {
 await this.login();
 } catch (err) {
 console.error("[WeChat] 登录失败，微信功能暂不可用:", err instanceof Error ? err.message : err);
 return;
 }
 } else {
 console.log("[WeChat] 已加载保存的 Token");
 }

 this.loadContextTokens();
 if (this.contextTokens.size > 0) {
 console.log(`[WeChat] 已加载 ${this.contextTokens.size} 个会话 context_token（支持主动发消息）`);
 }

 console.log("[WeChat] Bot 就绪，开始长轮询...");
 this.polling = true;
 await sleep(1500); // 等服务端 session 初始化
 void this.pollLoop();

 await new Promise ((resolve) => { this.stopResolve = resolve; });
 }

 async stop(): Promise {
 this.polling = false;
 this.stopResolve?.();
 console.log("[WeChat] Bot 已停止");
 }

 async sendMessage(msg: OutgoingMessage): Promise {
 const contextToken = this.contextTokens.get(msg.chatId);
 if (!contextToken) {
 console.warn(`[WeChat] 找不到 ${msg.chatId} 的 context_token，无法发送消息`);
 return;
 }
 console.log(`[WeChat] 发送消息到 ${msg.chatId}, 有图片=${!!msg.mediaUrl}`);
 if (msg.mediaUrl) {
 await this.sendImage(contextToken, msg.chatId, msg.mediaUrl, msg.text ?? "", msg.fallbackText ?? msg.text ?? "");
 } else {
 await this.sendText(contextToken, msg.chatId, msg.text ?? "");
 }
 }

 // ── 登录流程 ───────────────────────────────────────────────────────────────

 private async login(): Promise {
 console.log("[WeChat] 获取登录二维码...");

 const res = await axios.get<{ qrcode: string; qrcode_img_content: string; ret: number }>(
 `${BASE_URL}/ilink/bot/get_bot_qrcode`,
 { params: { bot_type: 3 }, timeout: 15_000, ...axiosDirect },
 );

 const { qrcode, qrcode_img_content: qrcodeUrl } = res.data;

 console.log("\n[WeChat] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
 console.log("[WeChat] 请用微信扫描以下二维码登录：");
 console.log(`[WeChat] ${qrcodeUrl}`);
 console.log("[WeChat] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

 try {
 const qrTerm = await import("qrcode-terminal" as string) as { generate: (url: string, opts: object) => void };
 qrTerm.generate(qrcodeUrl, { small: true });
 } catch { /* 未安装，忽略 */ }

 console.log("[WeChat] 等待扫码...");
 const deadline = Date.now() + 5 * 60 * 1000;

 while (Date.now() < deadline) {
 await sleep(2000);
 try {
 const statusRes = await axios.get(
 `${BASE_URL}/ilink/bot/get_qrcode_status`,
 { params: { qrcode }, timeout: 60_000, ...axiosDirect },
 );
 const { status, bot_token, baseurl } = statusRes.data as {
 status: string; bot_token?: string; baseurl?: string;
 };

 if (status === "scanned") {
 console.log("[WeChat] 已扫码，等待手机端确认...");
 } else if (status === "confirmed" && bot_token) {
 this.botToken = bot_token;
 if (baseurl) this.baseUrl = baseurl;
 this.saveToken(bot_token);
 console.log("[WeChat] 登录成功！");
 return;
 }
 } catch (err) {
 console.warn("[WeChat] 状态查询失败，重试中:", err instanceof Error ? err.message : err);
 await sleep(3000);
 }
 }
 throw new Error("扫码等待超时（5分钟）");
 }

 // ── 长轮询消息 ─────────────────────────────────────────────────────────────

 private async pollLoop(): Promise {
 while (this.polling) {
 try {
 const body: Record<string, unknown> = {
 base_info: { channel_version: CHANNEL_VERSION },
 };
 if (this.updatesBuf) body["get_updates_buf"] = this.updatesBuf;

 const res = await this.http.post (
 "ilink/bot/getupdates",
 body,
 );

 const { ret, errcode, msgs, get_updates_buf } = res.data;
 const code = errcode ?? ret ?? 0;

 if (code !== 0) {
 console.error(`[WeChat] getupdates 错误 code=${code} ${res.data.errmsg ?? ""}`);
 if (code === -14) {
 console.warn("[WeChat] Session 已过期，重新登录...");
 this.botToken = null;
 this.updatesBuf = "";
 this.deleteToken();
 await this.login();
 } else {
 await sleep(3000);
 }
 continue;
 }

 // 更新游标
 if (get_updates_buf) this.updatesBuf = get_updates_buf;

 for (const msg of msgs ?? []) {
 await this.handleMessage(msg);
 }
 } catch (err) {
 if (!this.polling) break;
 console.error("[WeChat] 轮询异常:", err instanceof Error ? err.message : err);
 await sleep(5000);
 }
 }
 }

 private async handleMessage(msg: WeChatMessage): Promise {
 // 识别 Bot ID
 if (!this.botId && msg.to_user_id) {
 this.botId = msg.to_user_id;
 console.log(`[WeChat] 识别到 Bot ID: ${this.botId}`);
 }

 // 过滤自身发出的消息，防止递归回复循环
 if (this.botId && msg.from_user_id === this.botId) {
 // console.log(`[WeChat] 跳过自身消息 from=${msg.from_user_id}`);
 return;
 }

 console.log(`[WeChat] 收到消息: type=${msg.message_type} from=${msg.from_user_id} context_token=${msg.context_token} items=${JSON.stringify(msg.item_list)}`);
 if (!this.handler) return;
 // 只处理用户发来的消息（message_type=1）
 if (msg.message_type !== 1) return;

 // 去重：生成稳定的去重 key
 const msgKey = this.generateStableKey(msg);
 const textPreview = msg.item_list?.[0]?.text_item?.text?.slice(0, 20) || '非文本';
 const now = Date.now();
 const lastSeen = this.seenMessageKeys.get(msgKey);
 if (lastSeen && now - lastSeen < this.DEDUP_WINDOW_MS) {
 console.log(`[FLOW][WeChat] 重复跳过 key=${msgKey} text="${textPreview}"`);
 return;
 }
 this.seenMessageKeys.set(msgKey, now);
 console.log(`[FLOW][WeChat] 新消息 key=${msgKey} text="${textPreview}"`);

 // 定期清理过期的 key（每100条清理一次）
 if (this.seenMessageKeys.size % 100 === 0) {
 this.cleanupSeenKeys();
 }

 // 保存 context_token
 this.contextTokens.set(msg.from_user_id!, msg.context_token!);
 this.saveContextTokens();

 const textItem = msg.item_list?.find((i) => i.type === 1);
 const imageItem = msg.item_list?.find((i) => i.type === 2);
 const voiceItem = msg.item_list?.find((i) => i.type === 3);

 let messageText = "";
 let images: IncomingImage[] | undefined;

 // 纯图片消息：缓存 image_item 供后续引用
 if (imageItem?.image_item) {
 this.cacheImageItem(imageItem);
 const downloaded = await this.tryDownloadImage(imageItem.image_item, "direct");
 if (downloaded) {
 images = [downloaded];
 console.log(`[WeChat] 图片消息已就绪 from=${msg.from_user_id}`);
 } else {
 console.warn(`[WeChat] 图片消息下载失败 from=${msg.from_user_id} item=${this.safeImageLog(imageItem.image_item)}`);
 }
 }

 // 文字消息（可能附带引用图片）
 if (textItem?.text_item?.text) {
 messageText = textItem.text_item.text;
 console.log(`[WeChat] 处理文字消息: "${messageText}" from=${msg.from_user_id}`);

 if (!images?.length && textItem.ref_msg?.message_item) {
 const refDownloaded = await this.resolveRefMessageImage(textItem.ref_msg.message_item);
 if (refDownloaded) {
 images = [refDownloaded];
 console.log(`[WeChat] 已从引用消息提取图片 from=${msg.from_user_id}`);
 }
 }
 } else if (voiceItem) {
 const voiceText = voiceItem.voice_item?.text;
 if (!voiceText) {
 console.log(`[WeChat] 语音消息无文字识别结果 from=${msg.from_user_id}`);
 return;
 }
 messageText = voiceText;
 console.log(`[WeChat] 处理语音消息: "${messageText}" from=${msg.from_user_id}`);
 } else if (!images?.length) {
 console.log(`[WeChat] 忽略不支持的消息类型 from=${msg.from_user_id} items=${JSON.stringify(msg.item_list)}`);
 return;
 }

 if (!messageText && !images?.length) return;

 await this.handler({
 userId: msg.from_user_id!,
 chatId: msg.from_user_id!,
 text: messageText,
 images,
 platform: "wechat",
 timestamp: new Date(),
 });
 }

 // ── 图片下载（CDN） ─────────────────────────────────────────────────────────

 private cacheImageItem(item: MessageItem): void {
 if (!item.msg_id || !item.image_item) return;
 this.imageItemCache.set(item.msg_id, item.image_item);
 if (this.imageItemCache.size > 200) {
 const first = this.imageItemCache.keys().next().value;
 if (first) this.imageItemCache.delete(first);
 }
 }

 private safeImageLog(imageItem: WeChatImageItem): string {
 return JSON.stringify({
 hasMedia: !!imageItem.media,
 hasParam: !!imageItem.media?.encrypt_query_param,
 hasAesKey: !!(imageItem.aeskey || imageItem.media?.aes_key),
 mediaId: imageItem.media_id ?? null,
 });
 }

 private async tryDownloadImage(
 imageItem: WeChatImageItem,
 source: string,
 ): Promise<IncomingImage | null> {
 let result = await downloadWeChatImage(imageItem);
 if (!result && imageItem.media_id) {
 result = await this.downloadImageViaLegacyApi(imageItem.media_id);
 if (result) console.log(`[WeChat] 图片通过 legacy API 下载成功 source=${source}`);
 }
 if (!result) {
 console.warn(`[WeChat] 图片下载失败 source=${source} ${this.safeImageLog(imageItem)}`);
 }
 return result;
 }

 /** 旧版 media_id 下载（CDN 字段缺失时的备用） */
 private async downloadImageViaLegacyApi(mediaId: string): Promise<IncomingImage | null> {
 try {
 const res = await this.http.post<{
 errcode?: number; ret?: number; errmsg?: string;
 download_url?: string; url?: string;
 encrypt_query_param?: string;
 aes_key?: string;
 }>("ilink/bot/getdownloadinfo", {
 media_id: mediaId,
 base_info: { channel_version: CHANNEL_VERSION },
 });
 const code = res.data.errcode ?? res.data.ret ?? 0;
 if (code !== 0) return null;

 if (res.data.encrypt_query_param && res.data.aes_key) {
 return downloadWeChatImage({
 media: {
 encrypt_query_param: res.data.encrypt_query_param,
 aes_key: res.data.aes_key,
 },
 });
 }

 const url = res.data.download_url ?? res.data.url;
 if (!url) return null;
 const imgRes = await axios.get<ArrayBuffer>(url, { ...axiosDirect, responseType: "arraybuffer", timeout: 30_000 });
 const buffer = Buffer.from(imgRes.data);
 if (buffer[0] === 0xff || buffer[0] === 0x89 || buffer[0] === 0x47) {
 return {
 data: buffer.toString("base64"),
 mediaType: buffer[0] === 0xff ? "image/jpeg" : buffer[0] === 0x89 ? "image/png" : "image/gif",
 };
 }
 return null;
 } catch {
 return null;
 }
 }

 /** 从「引用回复」里取图片：优先完整 image_item，否则查缓存 */
 private async resolveRefMessageImage(refItem: MessageItem): Promise<IncomingImage | null> {
 if (refItem.type === 2 && refItem.image_item) {
 return this.tryDownloadImage(refItem.image_item, "ref_direct");
 }

 if (refItem.msg_id) {
 const cached = this.imageItemCache.get(refItem.msg_id);
 if (cached) {
 return this.tryDownloadImage(cached, "ref_cache");
 }
 console.warn(`[WeChat] 引用消息 ${refItem.msg_id} 无缓存，type=${refItem.type}`);
 }

 return null;
 }

 // ── 发送消息 ───────────────────────────────────────────────────────────────

 private async sendText(contextToken: string, toUserId: string, text: string): Promise<boolean> {
 if (!text.trim()) return true;
 const plain = stripMarkdown(text);
 const chunks = splitText(plain, 2000);
 for (const chunk of chunks) {
  const ok = await this.sendTextChunk(contextToken, toUserId, chunk);
  if (!ok) return false;
 }
 return true;
 }

 private async sendTextChunk(
 contextToken: string,
 toUserId: string,
 chunk: string,
 ): Promise<boolean> {
 const maxAttempts = 4;
 for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  const clientId = `im-claude-${crypto.randomBytes(8).toString("hex")}`;
  console.log(`[WeChat] sendmessage to=${toUserId} len=${chunk.length} clientId=${clientId} attempt=${attempt}`);
  try {
   const res = await this.http.post<SendMessageResponse>("ilink/bot/sendmessage", {
    msg: {
     from_user_id: "",
     to_user_id: toUserId,
     client_id: clientId,
     message_type: 2,
     message_state: 2,
     context_token: contextToken,
     item_list: [{ type: 1, text_item: { text: chunk } }],
    },
    base_info: { channel_version: CHANNEL_VERSION },
   });
   const code = res.data.errcode ?? res.data.ret ?? 0;
   if (code === 0) {
    console.log(`[WeChat] sendmessage 成功`);
    return true;
   }
   console.error(`[WeChat] sendmessage 失败 code=${code}: ${res.data.errmsg}`);
   if (code === -2 && attempt < maxAttempts) {
    const waitMs = 1500 * attempt;
    console.warn(`[WeChat] prepare failed，${waitMs}ms 后重试...`);
    await sleep(waitMs);
    continue;
   }
   return false;
  } catch (err) {
   console.error(`[WeChat] sendmessage 异常:`, err instanceof Error ? err.message : err);
   if (attempt < maxAttempts) {
    await sleep(1500 * attempt);
    continue;
   }
   return false;
  }
 }
 return false;
 }

 private async sendImage(contextToken: string, toUserId: string, imageUrl: string, caption: string, fallbackText = caption): Promise<void> {
 try {
 const uploaded = await this.uploadMedia(imageUrl, toUserId);
 // aes_key in sendmessage = base64(hex字符串)，与官方实现一致
 const aesKeyBase64 = Buffer.from(uploaded.aeskeyHex).toString("base64");
 const clientId = `im-claude-${crypto.randomBytes(8).toString("hex")}`;
 console.log(`[WeChat] 发送图片 clientId=${clientId} mid_size=${uploaded.fileSizeCiphertext}`);
 const res = await this.http.post ("ilink/bot/sendmessage", {
 msg: {
 from_user_id: "",
 to_user_id: toUserId,
 client_id: clientId,
 message_type: 2,
 message_state: 2,
 context_token: contextToken,
 item_list: [{
 type: 2,
 image_item: {
 media: {
 encrypt_query_param: uploaded.downloadEncryptedQueryParam,
 aes_key: aesKeyBase64,
 encrypt_type: 1,
 },
 mid_size: uploaded.fileSizeCiphertext, // 密文大小
 },
 }],
 },
 base_info: { channel_version: CHANNEL_VERSION },
 });
 const code = res.data.errcode ?? res.data.ret ?? 0;
 if (code !== 0) throw new Error(`sendmessage(image) 失败 code=${code}: ${res.data.errmsg}`);
 console.log("[WeChat] 图片发送成功");
 if (caption) await this.sendText(contextToken, toUserId, caption);
 } catch (err) {
 console.warn("[WeChat] 图片发送失败，降级为发链接:", err instanceof Error ? err.message : err);
 await this.sendText(contextToken, toUserId, fallbackText || imageUrl);
 }
 }

 /** AES-128-ECB 密文大小（PKCS7 padding 到 16 字节边界） */
 private aesEcbPaddedSize(plaintextSize: number): number {
 return Math.ceil((plaintextSize + 1) / 16) * 16;
 }

 /** 下载图片并通过加密流程上传到微信 CDN，返回用于发送的 image_item */
 private async uploadMedia(imageUrl: string, toUserId: string): Promise<{
 downloadEncryptedQueryParam: string;
 aeskeyHex: string;
 fileSize: number;
 fileSizeCiphertext: number;
 }> {
 const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

 // Step 1: 读取图片（支持本地 file:// 路径或 HTTP URL）
 console.log(`[WeChat] 读取图片: ${imageUrl}`);
 let buffer: Buffer;
 if (imageUrl.startsWith("file://") || (!imageUrl.startsWith("http") && fs.existsSync(imageUrl))) {
 const filePath = imageUrl.startsWith("file://") ? imageUrl.slice(7) : imageUrl;
 buffer = fs.readFileSync(filePath);
 } else {
 const imgRes = await axios.get(imageUrl, {
  ...axiosDirect,
  responseType: "arraybuffer",
  timeout: 30_000,
  maxRedirects: 5,
 });
 buffer = Buffer.from(imgRes.data);
 }
 const rawsize = buffer.length;
 const rawfilemd5 = crypto.createHash("md5").update(buffer).digest("hex");
 const filesize = this.aesEcbPaddedSize(rawsize); // 密文大小
 console.log(`[WeChat] 图片下载完成 rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5}`);

 // Step 2: 生成 aeskey(hex) 和 filekey，获取上传授权
 const aesKeyBuf = crypto.randomBytes(16);
 const aeskeyHex = aesKeyBuf.toString("hex");
 const filekey = crypto.randomBytes(16).toString("hex");

 const authRes = await this.http.post<{
 ret?: number; errcode?: number; errmsg?: string;
 upload_param?: string;
 }>("ilink/bot/getuploadurl", {
 filekey,
 media_type: 1, // IMAGE
 to_user_id: toUserId,
 rawsize,
 rawfilemd5,
 filesize,
 no_need_thumb: true,
 aeskey: aeskeyHex, // hex 编码
 base_info: { channel_version: CHANNEL_VERSION },
 });
 const authCode = authRes.data.errcode ?? authRes.data.ret ?? 0;
 if (authCode !== 0) throw new Error(`getuploadurl 失败 code=${authCode}: ${authRes.data.errmsg}`);

 const { upload_param } = authRes.data;
 if (!upload_param) throw new Error("getuploadurl 未返回 upload_param");
 console.log(`[WeChat] 获取上传授权成功`);

 // Step 3: AES-128-ECB 加密图片数据
 const cipher = crypto.createCipheriv("aes-128-ecb", aesKeyBuf, null);
 const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);

 // Step 4: 上传到 CDN（不带 Authorization header）
 const cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload_param)}&filekey=${encodeURIComponent(filekey)}`;
 console.log(`[WeChat] 上传加密图片到 CDN...`);
 const cdnRes = await axios.post(cdnUrl, encrypted, {
  ...axiosDirect,
  headers: { "Content-Type": "application/octet-stream" },
  timeout: 60_000,
  validateStatus: () => true,
 });

 const downloadEncryptedQueryParam = cdnRes.headers["x-encrypted-param"] as string | undefined;
 if (!downloadEncryptedQueryParam) {
 throw new Error(`CDN 上传失败 status=${cdnRes.status}，未返回 x-encrypted-param`);
 }
 console.log(`[WeChat] CDN 上传成功`);

 return { downloadEncryptedQueryParam, aeskeyHex, fileSize: rawsize, fileSizeCiphertext: filesize };
 }

 // ── Token 持久化 ───────────────────────────────────────────────────────────

 private loadToken(): string | null {
 const primary = tokenFile();
 const parsed = this.readTokenFile(primary);
 if (parsed) return parsed;

 for (const candidate of legacyTokenCandidates()) {
  if (path.resolve(candidate) === path.resolve(primary)) continue;
  const legacy = this.readTokenFile(candidate);
  if (legacy) {
   console.log(`[WeChat] 从旧路径迁移 Token: ${candidate} → ${primary}`);
   this.botToken = legacy;
   // baseurl 已在 readTokenFile 里写到 this.baseUrl
   this.saveToken(legacy);
   try { fs.unlinkSync(candidate); } catch { /* ignore */ }
   return legacy;
  }
 }
 return null;
 }

 private readTokenFile(filePath: string): string | null {
 try {
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return null;
  const data = JSON.parse(raw) as { token: string; baseurl?: string };
  if (data.baseurl) this.baseUrl = data.baseurl;
  return data.token || null;
 } catch {
  return null;
 }
 }

 private saveToken(token: string): void {
 try {
  ensurePersistDir();
  fs.writeFileSync(tokenFile(), JSON.stringify({ token, baseurl: this.baseUrl }), "utf-8");
  console.log(`[WeChat] Token 已保存到 ${tokenFile()}`);
 } catch (err) { console.warn("[WeChat] 无法保存 Token:", err); }
 }

 private deleteToken(): void {
 try { fs.unlinkSync(tokenFile()); } catch { /* 忽略 */ }
 }

 private loadContextTokens(): void {
 const primary = contextFile();
 if (this.readContextFile(primary)) return;

 for (const candidate of legacyContextCandidates()) {
  if (path.resolve(candidate) === path.resolve(primary)) continue;
  if (this.readContextFile(candidate)) {
   console.log(`[WeChat] 从旧路径迁移 context_token: ${candidate} → ${primary}`);
   this.saveContextTokens();
   try { fs.unlinkSync(candidate); } catch { /* ignore */ }
   return;
  }
 }
 }

 private readContextFile(filePath: string): boolean {
 try {
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return false;
  const data = JSON.parse(raw) as Record<string, string>;
  this.contextTokens = new Map(Object.entries(data));
  return this.contextTokens.size > 0;
 } catch {
  return false;
 }
 }

 private saveContextTokens(): void {
 try {
  ensurePersistDir();
  fs.writeFileSync(contextFile(), JSON.stringify(Object.fromEntries(this.contextTokens)), "utf-8");
 } catch (err) { console.warn("[WeChat] 无法保存 context_token:", err); }
 }

 /**
 * 生成稳定的去重 key
 * 优先使用 create_time_ms，没有则根据消息类型使用不同策略
 */
 private generateStableKey(msg: WeChatMessage): string {
 const userId = msg.from_user_id ?? "unknown";
 const item = msg.item_list?.[0];
 if (!item) return `${userId}:unknown`;

 // 优先使用 create_time_ms（最可靠）
 if (item.create_time_ms) {
 return `${userId}:${item.create_time_ms}:${item.type}`;
 }

 // 文本消息：使用内容 hash + 10秒时间窗口
 if (item.type === 1 && item.text_item?.text) {
 const timeWindow = Math.floor(Date.now() / 10_000);
 return `${userId}:text:${this.simpleHash(item.text_item.text)}:${timeWindow}`;
 }

 // 图片消息：使用 media_id（稳定）
 if (item.type === 2) {
 const mediaId = (item.image_item as { media_id?: string }).media_id ?? "unknown";
 return `${userId}:img:${mediaId}`;
 }

 // 语音消息：使用识别文本 hash + 10秒时间窗口
 if (item.type === 3 && item.voice_item?.text) {
 const timeWindow = Math.floor(Date.now() / 10_000);
 return `${userId}:voice:${this.simpleHash(item.voice_item.text)}:${timeWindow}`;
 }

 // Fallback：时间窗口（粗粒度去重）
 const timeWindow = Math.floor(Date.now() / 5_000);
 return `${userId}:fallback:${item.type}:${timeWindow}`;
 }

 /**
 * 简单的字符串 hash（非加密用途）
 */
 private simpleHash(str: string): string {
 let hash = 0;
 for (let i = 0; i < str.length; i++) {
 const char = str.charCodeAt(i);
 hash = ((hash << 5) - hash) + char;
 hash = hash & hash; // 转为 32bit 整数
 }
 return Math.abs(hash).toString(36).slice(0, 8);
 }

 /**
 * 清理过期的 seenMessageKeys，防止内存泄漏
 */
 private cleanupSeenKeys(): void {
 const now = Date.now();
 const cutoff = now - this.DEDUP_WINDOW_MS;
 let cleaned = 0;
 for (const [key, timestamp] of this.seenMessageKeys) {
 if (timestamp < cutoff) {
 this.seenMessageKeys.delete(key);
 cleaned++;
 }
 }
 if (cleaned > 0) {
 console.log(`[WeChat][dedup] 清理了 ${cleaned} 条过期记录，剩余 ${this.seenMessageKeys.size}`);
 }
 }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise {
 return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitText(text: string, maxLen: number): string[] {
 if (text.length <= maxLen) return [text];
 const chunks: string[] = [];
 for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
 return chunks;
}

/** 生成随机 X-WECHAT-UIN header（同官方实现） */
function randomWechatUin(): string {
 const uint32 = crypto.randomBytes(4).readUInt32BE(0);
 return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** 去掉 Markdown 格式，微信不渲染 markdown */
function stripMarkdown(text: string): string {
 return text
 .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_: string, code: string) => code.trim())
 .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
 .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
 .replace(/^\|[\s:|-]+\|$/gm, "")
 .replace(/^\|(.+)\|$/gm, (_: string, inner: string) =>
 inner.split("|").map((c: string) => c.trim()).join(" "))
 .replace(/\*\*(.+?)\*\*/g, "$1")
 .replace(/\*(.+?)\*/g, "$1")
 .replace(/`(.+?)`/g, "$1")
 .replace(/^#+\s+/gm, "")
 .replace(/^[-*]\s+/gm, "• ");
}
