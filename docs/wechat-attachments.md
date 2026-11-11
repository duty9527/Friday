# 微信个人号附件（iLink）

协议依据：npm 公开包 `@tencent-weixin/openclaw-weixin@2.4.10` 的
`src/cdn/upload.ts`, `cdn-upload.ts`, `messaging/send.ts`。不需要新登录凭据。

## 启用与调用

1. 本机管理员创建**专用空目录**（建议权限 0700），设置服务进程环境变量
   `FRIDAY_WECHAT_ATTACHMENT_DIR=/absolute/dedicated/outbox`。
   目录内的普通单链接文件均视为管理员允许交付的文件；不要指向 home、仓库、备份目录。
2. 通过现有通道配置，把允许接收附件的微信 sender ID **精确**加入 `allowedSenders`。
   空列表和仅显示名称匹配不授权附件。
3. 将经过检查的无敏感文件放入目录；需要部署新构建并在合适时间由管理员重启服务才能加载代码及环境变量。
4. 该 sender 在微信当前聊天发送 `/file report.pdf`。只接受文件名，不接受路径或 URL。
   只有 bot token 认证的 iLink getupdates 轮询消息可触发；公开 webhook 和直接 ingest 不可触发。
   收件人固定为该消息 sender，context 固定为该消息 context_token，不使用 defaultTarget 回退。

本次开发没有重启服务，没有真实上传或发送，也没有读取/复制敏感备份。
失败记录在通道 `lastError`，不自动重试（发送超时可能已有送达，避免重复）。

## 本地策略与边界

- 当前采用有界内存缓冲，单文件 1 字节至 **16 MiB**、全进程单附件并发；这是本地内存策略，**不是腾讯出站大小上限**。220.3 MiB 文件不支持。
- 只允许专用目录直属的普通单硬链接文件，拒绝符号链接、目录、设备、路径穿越。
- 仅允许腾讯 `https://novac2c.cdn.weixin.qq.com` 上传地址，不跟随跳转；未来上游若换 CDN 需复核后更新。
- getuploadurl/sendmessage 检查 HTTP 和业务 ret/errcode；上传检查 HTTP 200 和 x-encrypted-param。
  各网络请求有超时，错误不回显 token/key/上传 URL 或上游响应正文。
- 本机管理员及可写 staging 的进程属于信任边界；不应允许不可信用户写该目录。
- 不提供大文件流式传输；内存使用包含明文/密文及加密中间缓冲。服务端大小兼容性与真实送达未验证。
