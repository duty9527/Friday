# 微信个人号出站排版与附件（iLink）

协议依据：npm 公开包 `@tencent-weixin/openclaw-weixin@2.4.10` 的
`src/cdn/upload.ts`, `cdn-upload.ts`, `messaging/send.ts`, `messaging/markdown-filter.ts`。不需要新登录凭据。

## 出站排版、分片与原生媒体路由

- **严格出站处理顺序**：先对齐 Markdown 表格（CJK 宽字符等宽对齐）并提取超过 1200 字的闭合代码围栏为独立文件附件（`snippet-N.<ext>`），再执行 `StreamingMarkdownFilter`（剥离 H5/H6 标记、CJK 斜体标记与未消费的图片标签，保留 H1–H4、`*`/`**`、代码块与 CRLF/缩进），最后按段落/行边界分片（每片 ≤ 1500 字，片间 150ms 间隔）。
- **按扩展名自动选择原生气泡**：通过 `/file` 或 Router `send_file` 发送暂存区文件时，图片（`.png/.jpg/.jpeg/.gif/.webp/.bmp`）走 `media_type: 1` (`type: 2 image_item`)，视频（`.mp4/.mov/.avi/.mkv/.webm`）走 `media_type: 2` (`type: 5 video_item`)，其余扩展名走 `media_type: 3` (`type: 4 file_item`)。
- **免打扰时段（Quiet Hours）**：配置 `quietHours` 后，系统自主定时推送（`source === 'system'`）若落入免打扰时段，将自动推迟到时段结束后再投递，不消耗重试次数；用户主动发起的实时对话回复永不受免打扰阻断。

## 启用与调用

1. 本机管理员创建**专用空目录**（建议权限 `0700`），为服务进程设置环境变量
   `FRIDAY_WECHAT_ATTACHMENT_DIR=/absolute/dedicated/outbox`（旧环境变量仅保留兼容读取）。
   目录内的普通单链接文件均视为管理员允许交付的文件；不要指向用户主目录、仓库目录或备份目录。
2. 通过现有通道配置，把允许接收附件的微信 sender ID **精确**加入 `allowedSenders`。
   空列表和仅显示名称匹配不授权附件。
3. 将经过检查的无敏感文件放入该专用目录；如修改了环境变量，需重启服务进程使其生效。
4. 该 sender 在微信当前聊天发送 `/file report.pdf`。只接受文件名，不接受路径或 URL。
   只有 bot token 认证的 iLink `getupdates` 轮询消息可触发；公开 webhook 和直接 ingest 不可触发。
   收件人固定为该消息 `sender`，上下文固定为该消息 `context_token`，不使用 `defaultTarget` 回退。

发送失败会记录在通道 `lastError`，不自动重试（发送超时可能已有送达，避免重复投递）。

## 本地策略与边界

- 当前采用有界内存缓冲，单文件 1 字节至 **16 MiB**、全进程单附件并发；这是本地内存策略，**不是腾讯出站大小上限**。
- 只允许专用目录直属的普通单硬链接文件，拒绝符号链接、目录、设备、路径穿越。
- 仅允许腾讯 `https://novac2c.cdn.weixin.qq.com` 或 `*.cdn.weixin.qq.com` 上传地址，不跟随跳转；未来上游若换 CDN 需复核后更新。
- `getuploadurl` / `sendmessage` 检查 HTTP 状态码与业务 `ret` / `errcode`（兼容 64 位整数 ID）；上传检查 HTTP 200 和 `x-encrypted-param`。
  各网络请求有超时控制，错误不回显 token、key、上传 URL 或上游响应正文。
- 本机管理员及可写该目录的进程属于信任边界；不应允许不可信用户写该目录。
- 不提供大文件流式传输；内存使用包含明文/密文及加密中间缓冲。
