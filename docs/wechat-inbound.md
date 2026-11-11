# 微信 iLink 入站附件

## 根因及链路

此前 `parseWechatIlinkMessage` 仅提取 `text_item`，纯媒体返回空；混合消息只有文字进入消息库，`AgentSession.prompt` 也未传图片。发送附件能力与此无关。

现在：iLink `type=2/image_item`、`type=4/file_item` → 发送人校验 → 受限 CDN 下载 → AES-128-ECB / PKCS#7 解密 → 私有随机文件 → 当前用户消息的 `attachments` 元数据和原有 `origin` 一起存入 SQLite → 当前 Router HOST_EVENT → SDK `prompt(..., {images})`。文件路径同时进入消息 `paths`，现有 start_work 会继承给 native Worker；原名只作元数据，不参与磁盘路径。文件内容是不可信数据，不授权执行。

公开协议核对来源：npm `@tencent-weixin/openclaw-weixin@2.4.10`，`src/api/types.ts`、`src/cdn/{pic-decrypt,cdn-url,aes-ecb}.ts`、`src/messaging/process-message.ts`。支持 base64(raw key)、base64(hex key) 以及图片 `aeskey` 的 hex 形式。不会记录下载 URL、key 或 token。与该公开版本一致，允许参数式 URL 回退，但本服务额外固定 CDN 主机且禁止重定向。

## 授权、安全与本地限制

- 媒体仅接受 bot token 认证的 getupdates 轮询所产生、带进程内来源标记的入站对象；公开 webhook/直接 ingest 即使声称精确授权 sender 也不下载，正文保留并显示失败状态。来源标记不接受 JSON 字段，也不影响已有 `/file` 独立授权。
- 普通入站仍遵守 allowedSenders；**媒体下载额外要求 allowedSenders 精确包含 sender ID，且 target=sender**。空列表、显示名匹配并不授权媒体。被普通规则拒绝的来源不下载；正文允许但媒体未授权时，当前消息保留正文及失败说明。
- 单条最多4个附件，每个明文16 MiB，密文最多16 MiB+16字节，流式读取遇超限即 cancel；单次20秒下载超时。这些是本地策略，不是腾讯上限。
- 仅 HTTPS `novac2c.cdn.weixin.qq.com` 的 `/c2c/` 路径，不接受用户任意 CDN/端口/凭据；重定向直接报错。不向媒体地址发送微信授权头。固定上游主机的 DNS/TLS 仍依赖系统信任，不实现任意域名代理。
- `<data-home>/inbound-media` 必须是非符号链接的0700目录；随机UUID文件，0600，exclusive/no-follow打开。已有不安全目录会拒绝，而非修改其权限。服务数据目录及其父目录由可信本机管理员管理。
- 附件与来源消息共同持久化，重开数据库不丢关联；重复已持久化的媒体消息不再次下载。下载失败进入可见消息文字和附件状态，不吞正文；没有后台重试或历史私人媒体补拉。
- 仅当前 CHAT 消息的成功图片会转成图像块，按文件魔数限定PNG/JPEG/GIF/WebP，并再检查大小和非链接文件。SDK请求前移除历史用户消息图像块及旧附件路径，避免在后续来源回合重放。全局共享文字历史/记忆仍是现有产品语义。
- 无远程附件下载/列目录/执行端点。当前消息文件可由 Router 委派可信 native Worker 读取；native Worker本来具有服务OS权限，**不是按会话沙箱**，此实现不声称可以隔离恶意本机进程或拥有原生工具的恶意Worker。Web/API仍是全局管理审计入口。原始 SDK session 日志也属于私有本机审计数据，包含当前轮图像，不应对外公开。

## 模型能力

安装的 SDK 1.5.0 支持 `PromptOptions.images`。目录中 `openai/gpt-6.1-sol` 声明 `input=[text,image]`（只读取运行会话的 model_change 元数据核对当前模型标识，未读取私人对话/媒体、未请求远程模型）。若切换到文本模型，或使用现有 `SUPER_AGENT_BASE_URL` 自定义兼容端点（当前注册为仅text），图片仍保存，但 HOST_MEDIA_STATUS 明确通知 Router不能看图，不会猜测视觉能力或静默宣称已看到。需配置 SDK 已声明支持图像且上游实际支持的模型。SDK自身对无效或不可缩放图片也可能拒绝/省略；没有OCR/PDF/Office解析或独立视觉Worker自动回退。

## 验证及生效

`test/wechat-inbound.test.ts` 覆盖AES双编码、CDN拒绝、超限/取消、失败状态、纯图/混合解析、无权来源零下载、图片块、数据库重开关联。`test/wechat-vision.test.ts` 从受授权iLink消息经mock下载、SQLite、真实SDK一路到本地mock HTTP服务，断言请求含正确PNG data URL、每次仅当前图像、下一会话不重放历史图像。测试图是生成的2x2 PNG，无私人内容。此验证证明字节真实进入SDK/模型传输请求，**不等于实际远程视觉模型已识别过用户图片**。

`test/wechat-provenance.test.ts` 额外验证伪造已授权 sender 的直接入站不会触发下载，且正文及失败状态均持久化。保护现有 `wechat-file.ts` 和 `/file` 发送入口、精确来源路由；运行构建和完整测试。未提交、未重启、未真实发送/上传微信消息。生效需要有权操作人员稍后重启服务，用户重新发送图片；不会恢复此前已被丢弃的图片。尚无累计磁盘配额/自动清理（本地管理员维护），也不自动恢复重启前中断的模型轮次。
