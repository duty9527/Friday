# Reply origins

Automatic IM output is exact-origin only. `notifyAll` is retained for configuration compatibility but no longer authorizes automatic conversation mirroring, including for existing enabled channels. Manual channel test/send remains an explicit administrative operation.

New user messages persist `origin` (platform/channel ID/account ID/conversation/sender and reply context) in the SQLite message body. Chat-created background tasks copy that origin from the current request, not from globally recalled context or a copied source task. Replies and worker completion/failure/interruption messages inherit the origin through `replyTo`. Old messages/tasks without origin are not inferred or broadcast. Account changes invalidate old reply routes.

IM work listing, status counts, stop/resume are scoped to the exact originating conversation and sender. Global memory remains global and explicit `/memories` still queries that shared memory. No history is deleted. The local web/API remains a trusted global administrative audit interface: it is NOT browser-user/session isolated. Multi-user web identity/access controls and scoped web history require a separate authenticated client contract; this patch does not claim those are implemented. Automatic web-to-IM and IM-to-other-IM output is disabled regardless of that global context.

Gateway startup starts watching new journal events and does not replay old completed messages. Pending work that completes after restart can route from persisted origin; failed sends are not automatically retried. Exact session webhook expiry may prevent delivery, but must not fall back to a default recipient.

Build/restart of the running service is needed to load the changes; no restart or live IM send was performed during implementation. Offline verification: `npm test` (82 passing, including mock routing and attachment protocol tests).
