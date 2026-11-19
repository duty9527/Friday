# 微信 iLink 入站能力

## 数据流与安全链路

iLink 入站 `type=2/image_item`、`type=3/voice_item`、`type=4/file_item`、`type=5/video_item` 与引用上下文（`refermsg` / `ref_msg`）→ 发送人校验（未授权来信留痕 `rejectedSenders`，可在控制台一键加白，且不下载媒体/不抓取外链）→ 受限 CDN 下载 → AES-128-ECB / PKCS#7 解密 → 私有随机文件 → 当前用户消息的 `attachments` 元数据和原有 `origin` 一起存入 SQLite → 当前 Router `HOST_EVENT` → SDK `prompt(..., { images })`。文件路径同时进入消息 `paths`，供受信任 `native` Worker 按需读取；原文件名仅作元数据展示，不参与磁盘路径拼接。文件内容、引用内容与外链正文均视为不可信数据，不授权自动执行。

公开协议参考 `@tencent-weixin/openclaw-weixin@2.4.10`（`src/api/types.ts`、`src/cdn/{pic-decrypt,cdn-url,aes-ecb}.ts`、`src/messaging/process-message.ts`），支持 base64(raw key)、base64(hex key) 以及图片 `aeskey` 的 hex 形式，并对 `message_id` / `msg_id` / `svr_id` 做 64 位整数精度保护。日志不会记录下载 URL、解密 key 或 token，固定 HTTPS `*.cdn.weixin.qq.com` 主机且禁止 HTTP 重定向。

## 多模态与上下文增强

- **语音转文字（`type=3/voice_item`）**：通过可选依赖 `silk-wasm` 将 SILK 音频本地解码为 24kHz WAV，重采样为 16kHz 后复用本机 `sherpa-onnx-node`（SenseVoice / Paraformer）离线识别并作为 `【语音转写】` 交付 Router；若本地 ASR 未就绪则优先回退 `voice_item.text`，无法识别或未装转码模块时附带诚实降级说明，不臆测语音内容。
- **视频关键帧视觉直连（`type=5/video_item`）**：下载解密视频后通过异步 `ffmpeg` 在时长 10%～90% 区间均匀抽取最多 3 帧 1280px PNG 静图，作为私有 `image/png` 图像附件并入当前轮，直接进入 `messageImages` Vision 通路（单条消息总附件上限 4 项）；`ffmpeg` 缺失或解码失败时降级保留视频文件。
- **引用回复与文档预抽取**：自动解析 `refermsg` / `appmsg.refermsg` / `quote` / `ref_msg` 为 `【引用】` 上下文块（截断脱敏）；对 `.docx`（零依赖 `node:zlib` 提取 `word/document.xml`）和纯文本文件抽取前 4000 字摘要随消息提供给 Router。
- **网页链接正文参考（`readLinks`，默认开启）**：对已授权私聊中的 `http(s)://` 链接（每次最多 3 条、单次 512KB / 8 秒超时、5 分钟缓存）进行逐跳手动重定向（最多 3 跳）与 DNS 解析后私网/回环/云元数据 IP 拦截，剥离 HTML 后作为不可信参考块注入。

## 授权、安全与本地限制

- 媒体仅接受 bot token 认证的 `getupdates` 轮询所产生、带进程内来源标记的入站对象；公开 webhook 或直接 ingest 即使声称已授权 sender 也不下载，正文保留并标注失败状态。来源标记不接受外部 JSON 字段伪造，也不影响已有 `/file` 独立授权。
- 普通入站仍遵守 `allowedSenders`；**媒体下载与 `readLinks` 外链抓取额外要求 `allowedSenders` 精确包含 `sender` ID，且 `target=sender`**。空列表与显示名称匹配不授权媒体。被普通规则拒绝的来源不下载、不抓链，并记录到通道 `rejectedSenders` 便于管理员在控制台核验加白。
- 单条最多 4 个入站媒体项，每个明文上限 16 MiB，密文上限 16 MiB + 16 字节，流式读取超限立即 `cancel`；单次 20 秒下载超时。上述均为本地资源保护策略。
- 仅允许 HTTPS `novac2c.cdn.weixin.qq.com` 或 `*.cdn.weixin.qq.com` 的 `/c2c/` 路径，不接受非微信 CDN 主机、自定义端口或重定向，也不向媒体 CDN 发送微信授权头。
- `<home>/inbound-media`（默认 `~/.friday/inbound-media`）必须是非符号链接的 `0700` 目录；媒体落地采用随机 UUID 文件名、`0600` 权限与 exclusive/no-follow 打开方式，发现不安全目录直接拒绝。
- 附件元数据与来源消息共同持久化；重复已持久化的媒体消息不重复下载。下载失败进入可见附件状态与提示文字，不吞正文，也不设后台自动重拉。
- 仅当前轮 `CHAT` 消息成功落盘的图片（含视频抽帧静图）会转为图像块，按文件魔数限定 PNG / JPEG / GIF / WebP 并校验体积与非链接属性；SDK 请求前剥离历史用户消息中的图像块及旧附件路径，避免在后续回合重放。
- 无远程附件下载、列目录或执行端点。`native` Worker 拥有服务账号 OS 权限而非逐会话沙箱；Web/API 为本机受信任全局管理入口，原始 SDK session 日志属于本机私有审计数据。

## 模型能力

SDK 通过 `PromptOptions.images` 传递当前轮图片。仅当所选模型在目录与上游能力中支持 `input=[text, image]` 时才附带图像块；若切换至纯文本模型，或通过 `FRIDAY_BASE_URL`（兼容 `SUPER_AGENT_BASE_URL`）连接仅支持文本的自定义兼容端点，附件文件仍会落盘并由 `HOST_MEDIA_STATUS` 明确告知 Router 当前模型不支持直接看图，不猜测或虚构视觉能力。

## 对应测试套件

相关协议与行为验证见 [`test/wechat-inbound.test.ts`](../test/wechat-inbound.test.ts)、[`test/wechat-vision.test.ts`](../test/wechat-vision.test.ts)、[`test/wechat-provenance.test.ts`](../test/wechat-provenance.test.ts)、[`test/wechat-media-enrich.test.ts`](../test/wechat-media-enrich.test.ts) 与 [`test/wechat-protocol-ops.test.ts`](../test/wechat-protocol-ops.test.ts)。
