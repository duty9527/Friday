# Reply origins

Automatic IM output is exact-origin only. `notifyAll` is retained for configuration compatibility but no longer authorizes automatic conversation mirroring, including for existing enabled channels. Manual channel test/send remains an explicit administrative operation.

New user messages persist `origin` (platform/channel ID/account ID/conversation/sender and reply context) in the SQLite message body. Chat-created background tasks copy that origin from the current request, not from globally recalled context or a copied source task. Replies and worker completion/failure/interruption messages inherit the origin through `replyTo`. Old messages/tasks without origin are not inferred or broadcast. Account changes invalidate old reply routes.

IM work listing, status counts, stop/resume are scoped to the exact originating conversation and sender. Global memory remains global and explicit `/memories` still queries that shared memory. No history is deleted. The local web/API remains a trusted global administrative audit interface: it is NOT browser-user/session isolated, and multi-user web identity/access controls or scoped web history require a separate authenticated client contract. Automatic web-to-IM and IM-to-other-IM output is disabled regardless of that global context.

A confirmed WeChat iLink QR login replaces the channel's default recipient with the user ID returned by iLink. Rebinding discards the previous account's delivery context; if confirmation does not include the binding identity, delivery is paused and a fresh QR is required. For proactive WeChat push, set the timer's delivery channel without a fixed target to follow the current binding; exact-origin replies are never redirected to a new recipient.

Gateway startup begins watching new journal events and does not replay old completed messages. Pending work that completes after restart can route from persisted origin; failed sends are not automatically retried. Exact session webhook expiry may prevent delivery, but must not fall back to a default recipient.
