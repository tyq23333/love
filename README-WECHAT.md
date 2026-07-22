# 微信 + Claude 接入指南

本项目基于 [im-claude](https://github.com/zytc2009/im-claude) 和腾讯官方 [iLink ClawBot API](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)，让你在微信里直接和 Claude 对话。

## 前置要求

- Node.js 18+
- Anthropic API Key（[console.anthropic.com](https://console.anthropic.com) 获取）
- 微信 iOS 客户端（Public Beta 体验更完整）

## 快速开始

### 1. 填入 API Key

编辑 `.env` 文件：

```
ANTHROPIC_API_KEY=sk-ant-你的密钥
WECHAT_ENABLED=true
TELEGRAM_ENABLED=false
```

### 2. 安装依赖

```powershell
cd $env:USERPROFILE\im-claude
npm install
```

### 3. 启动服务

```powershell
npm run dev
```

### 4. 扫码登录微信

终端会显示二维码和登录 URL，用微信扫码并在手机上确认登录。

Token 自动保存到 `.wechat-token`，重启后无需重新扫码（手动停止进程后需重新扫码）。

### 5. 发消息测试

在微信里给 Bot 发一条消息，例如「你好」。

首次可在 `.env` 中留空 `ALLOWED_USER_IDS`（允许所有人，仅开发用）。日志会打印你的微信用户 ID：

```
[WeChat] 处理文字消息: "你好" from=abc123@im.wechat
```

生产环境请把该 ID 填入白名单：

```
ALLOWED_USER_IDS=abc123@im.wechat
```

## 支持的命令

| 命令 | 说明 |
|------|------|
| 直接发文字 | 与 Claude 对话 |
| 语音消息 | 微信自动转文字后转发 |
| /clear | 清空对话历史 |
| /clearall | 清空所有虚拟人历史 |
| /personas | 列出可用虚拟人 |
| /testimage | 测试图片发送通道 |

## 技术原理

```
微信用户 → iLink API (ilinkai.weixin.qq.com) → WeChatAdapter → Claude Agent SDK → Claude API
```

- 收消息：长轮询 `getupdates`（类似 Telegram Bot）
- 发消息：`sendmessage`，必须带上 `context_token`
- 媒体：AES-128-ECB 加密后上传微信 CDN

## 常见问题

**Q: 登录二维码出不来？**  
确认网络能访问 `ilinkai.weixin.qq.com`。

**Q: Session 过期？**  
删除 `.wechat-token` 后重启，重新扫码。

**Q: 回复「无访问权限」？**  
检查 `ALLOWED_USER_IDS` 是否包含你的 `xxx@im.wechat` ID。

**Q: 想开放 Bash 工具让 Claude 操作电脑？**  
在 `.env` 中设置 `ALLOWED_TOOLS=Read,Glob,Grep,Write,Edit,Bash`（谨慎使用）。
