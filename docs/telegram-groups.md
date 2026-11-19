# Telegram 群聊验收

- 群成员中需要有该 bot，并允许 bot 发消息。使用 Telegram 快速接入会将 Bot API 返回的 `@username` 保存为通道的 `accountId`，用于核对群内提及与引用回复。
- 群里仅处理以下明确唤醒：
  1. Telegram 识别为实体的本 bot `@username` 提及或 `/命令@username`；
  2. 对本 bot 自己发言的直接引用回复（`reply_to_message.from` 为本 bot；Forum Topic 的 `forum_topic_created` 隐式父消息除外）；
  3. 本 bot 消息内联按钮的 `callback_query`。
- 发送人必须匹配 `allowedSenders` 中的数字用户 ID 或 `@username`；该名单为空时，使用通道的正数私聊 `defaultTarget`。不支持匿名群管理员（`sender_chat`）或 bot 发送人。默认不处理未点名的群消息，私聊规则不变。
- Telegram 通道可选配置 `telegramMentionExempt`，例如 `['-1001234567890:42']`，仅让指定群的 topic 42 中已授权用户发送的普通消息触发回复。只写负数 chat ID 表示该群的所有话题及非话题消息；字段未设置或为空时维持默认规则。该名单不替代 `allowedSenders`。只有依靠豁免才获准的消息会收到不带引用的平铺回复；明确 @ 本 bot 或引用回复本 bot 的消息仍按原方式引用。
  ```sh
  friday im add CHANNEL_ID --platform telegram --name 'Existing name' --telegram-mention-exempt=-1001234567890:42
  ```
  可重复传入 `--telegram-mention-exempt` 来替换整个名单，或传入 `--telegram-mention-exempt=` 清空。配置与 IM 通道一同保存在运行目录的 `state.sqlite`（`im_channels.body`）。
- 若群开启了 Topics（Forum），`parseTelegramUpdate` 会透传 `message_thread_id` 至入站与出站（文本、`sendChatAction` 及附件），确保在同一话题内原位回复。
- 由授权用户在群中用个人身份发送 `/id@你的机器人用户名`；正常时回复中有 `Chat ID`。再发送一条从 Telegram 候选项选中的 `@你的机器人用户名` 加简单问候，或直接引用回复 bot 消息，验证自然语言回复。不要用敏感内容做群聊验收。
- 验收免 @ 时，由授权的真人用户在配置的 topic 中发送一条不带 `@`、不引用 bot 的普通消息；不要用 bot 自己的 `sendMessage` 冒充真人入站。
- `journalctl --user -u friday.service --since '10 minutes ago' -g 'telegram-group-(update|send)'`：入站记录可区分路由、去重、未点名、未授权、匿名发送人（`group_anonymous_sender`）或成员状态变化；实际使用免 @ 规则时记录 `mentionExempt: true`。`telegram-group-send` 的 `accepted` 表示发送 API 接受文本请求，不代表客户端已读。`messageId` 为引用目标；平铺回复改用 `sourceMessageId` 关联入站，并记录 `hasReplyParameters: false`。`replyMessageId` 为 API 返回的出站消息编号。日志不写消息正文、群名或凭据。无关群消息不会逐条记日志。
- Bot API `getMe.can_read_all_group_messages=true` 表示全局 Group Privacy 已关闭。若仅测试点名，优先使用 `/id@username`：这是 Telegram 文档明确保证给 privacy-enabled bot 的定向命令之一，普通文本提及不作为保证。确需接收普通群消息或引用回复时，用 BotFather 的 `/setprivacy` → 选择 bot → `Disable`，按 Telegram 文档将 bot 从原群移除并重新加入以应用设置；这项 Telegram 侧操作本身不需要重启 Friday。
- 修改 Friday 的 TypeScript 后需编译并重启 `friday.service` 加载新代码。重启会短暂中断私聊及其他 IM 通道，应在没有在途工作时从服务外完成。
