# F.R.I.D.A.Y. · 全息神经记忆主脑与战术子 AI 协同系统

本地常驻、拥有**三层人脑全局记忆（L0 元记忆目录 + L2 语义记忆卡片与突触网络 + L1 情景对话/任务全量库）**、**双过程潜意识睡眠与做梦机制**以及完整本机编码工具的个人 AI 战术副手（**F.R.I.D.A.Y.**，*Female Replacement Intelligent Digital Assistant Youth*）。用户只面对**一个持续在线的声音**：主脑 Router 在微信、Web 控制台与终端 TUI 间无缝共享记忆，自动完成潜意识记忆闪回（Subconscious Memory Flashback）、跨上下文联想检索、编译无歧义的执行简报（Context Brief），按任务复杂度与模型能力在多提供商模型中枢（Model Hub）间动态调度专职后台子 AI（`coding` / `research` / `review` / `general`），并在子 AI 交付时扮演质量门禁（Quality Gate）或在中途遇到重大分岔时向老板发起战术请示（`ASK_BOSS`）。

**真实模式默认开放受信任本机工具：read / ls / find / grep / bash / edit / write。** 可以按需搜索读取、修改真实文件、执行命令和测试，无需附件。命令以服务账号运行，工作目录不是沙箱，可访问目录外、联网、安装依赖和执行破坏性操作；没有逐条审批、自动回滚或同目录并发写入保护。离线模拟仍为只读副本流程。已内置持久化全息记忆、潜意识睡眠巩固与只读 REM 做梦、自主巡航与一次性提醒定时器（Timers）、自进化插件工坊（Plugins）、全渠道 IM 网关（微信个人号 iLink 扫码/看图/发附件、钉钉、Telegram）、守护进程自愈与终端 TUI。目标和实现边界见 [目标规格](goal-and-requirements.md) 与 [架构规格](architecture.md)。

## F.R.I.D.A.Y. 核心能力与体验

在微信、Web 控制台、TUI 或 CLI 中，你可以直接体验 F.R.I.D.A.Y. 的人脑级记忆与战术协同能力：

- **三层全息神经记忆与突触可塑性（`memoryDirectory` / `save_memory` / `search_memory`）**：
  - **潜意识记忆闪回（`autoRecalled`）**：每次发言时，主脑在进入推理前自动跨全局语义记忆、历史 Worker 报告与历史对话混合检索（CJK 2-gram + 关键词 + `cwd` 空间亲和度 + 艾宾浩斯遗忘衰减 + 突触激活扩散），将高置信度命中直接注入本轮上下文。
  - **赫布突触连接与海马体任务巩固**：共同激活或同链路产出的记忆卡片自动建立带权突触（`synapses`），每个后台任务完成时自动沉淀结构化经验卡片；同一 `topic + cwd` 更新时自动标记旧卡片 `supersededBy` 实现新陈代谢。
- **双过程潜意识睡眠与做梦（Subconscious Sleep & Dreaming）**：
  - 采用人类睡眠的双过程模型（Borbély `S × C`：稳态睡眠压力 × 昼夜节律），仅在系统静默空闲且积累了未消化经历时自然入睡，老板永远无需也无法手动触发。
  - **两阶段睡眠**：第一阶段 NREM 慢波睡眠执行纯本地突触稳态修剪与记忆去重；第二阶段 REM 快速眼动期在只读白名单（`read`/`ls`/`find`/`grep`）与内存临时会话中漫游真实代码库，将白天的对话/报错与真实源码跨领域印证。
  - **瞬时惊醒与梦境遗忘曲线**：老板一旦发来消息，50ms 内中断做梦；仅在产出高价值洞见时保留半衰期 12 分钟、最多 2 轮对话的潜意识余温，绝不在看板或轨迹中刷屏。
- **异构模型中枢与专职子 AI 协同（Model Hub & Specialist Workers）**：
  - 支持 `openai`、`deepseek`、`anthropic`、`google`、`dashscope`、`openrouter` 等多提供商动态路由，按 `fast` / `balanced` / `strong` 三档自动匹配任务复杂度。
  - 同目录并发执行的多个子 AI 自动获知同伴态势（`concurrentPeers`），避免踩踏同一文件。
  - 主脑在 `WORKER_REPORT` 阶段担任老板的**质量门禁（Quality Gate）**：若子 AI 漏查关键位置或结论存疑，主脑自动在后台打回补查（`autoDispatchesRemaining`），验收合格后才向老板呈交。
- **战术中途请示与原会话拍板续跑（`ASK_BOSS` ↔ `BOSS_DECISION`）**：后台子 AI 遇到高危不可逆操作或重大业务分岔时可原地挂起向老板请示（挂起期间零活跃时限损耗，自动经由微信/Telegram/钉钉同步送达），老板在主对话随口回复拍板即可唤醒同一 Worker 会话无缝继续。
- **全渠道 IM 网关与微信个人号深度集成**：支持终端/Web 直接扫码绑定微信个人号（iLink 协议），支持微信端拆条消息与慢速图片智能聚合（Coalescing）、真实视觉看图（AES-128-ECB 解密直通模型视觉输入）、文档生成后自动通过 `send_file` 发送微信附件，以及严格的来源会话隔离路由（Exact-Origin Routing）。
- **一次性准点提醒与自进化插件工坊（`system-pulse` / `fund-tracker` / `<home>/plugins`）**：内置零外部依赖主机/Git 脉搏诊断与异常静默巡航插件 `system-pulse` 及基金持仓估值结算插件 `fund-tracker`，支持 `--delay-ms` / `--daily-at` / `--once` 零 Token 准点执行，并支持在数据目录动态锻造与凭据隔离运行新插件。
- **离线模拟快捷指令**：在 `--mode offline` 下，直接发送 `记住：主题=内容`、`搜索记忆：关键词`、`派发：任务描述`、`提醒：5秒后 事项`、`定时：指令` 即可端到端体验记忆刻印、联想闪回、专职子 AI 派发、一次性提醒与自主巡航定时器。

```sh
# CLI 全息态势简报与记忆管理（支持 npx friday 或 node dist/cli.js）
node dist/cli.js brief --home "$HOME/.super-agent-demo"
node dist/cli.js memory save --topic "鉴权规范" "统一采用 Ed25519 双令牌机制" --tag auth --pinned --home "$HOME/.super-agent-demo"
node dist/cli.js memory list --home "$HOME/.super-agent-demo"
node dist/cli.js memory search "Ed25519 鉴权" --home "$HOME/.super-agent-demo"
node dist/cli.js memory remove MEMORY_ID --home "$HOME/.super-agent-demo"

# 微信个人号扫码绑定与全渠道 IM 接入（微信 / 钉钉 / Telegram，共享同一个主脑与全局记忆）
node dist/cli.js im login --home "$HOME/.super-agent-demo"
node dist/cli.js im add --platform dingtalk --name "钉钉随身管家" --webhook-url "https://oapi.dingtalk.com/robot/send?access_token=..." --secret "SEC..." --allow "staffId" --home "$HOME/.super-agent-demo"
node dist/cli.js im add --platform telegram --name "Telegram 管家" --bot-token "123456:ABC..." --allow "@your_username" --home "$HOME/.super-agent-demo"
node dist/cli.js im list --home "$HOME/.super-agent-demo"
node dist/cli.js im test CHANNEL_ID "你好，我是 FRIDAY" --home "$HOME/.super-agent-demo"

# 插件运行与异构模型中枢管理
node dist/cli.js plugin list --home "$HOME/.super-agent-demo"
node dist/cli.js plugin run system-pulse status --home "$HOME/.super-agent-demo"
node dist/cli.js model list --home "$HOME/.super-agent-demo"

# 启动 F.R.I.D.A.Y. 交互式终端 TUI（支持 /brief, /memories, /search, /remember, /im, /works, /timers）
node dist/cli.js tui --home "$HOME/.super-agent-demo"
```

## 主对话与执行轨迹

先在终端一启动协调服务（下面用 offline 演示），再在终端二启动本地 Web：

```sh
node dist/cli.js serve --mode offline --home "$HOME/.super-agent-demo"
node dist/cli.js web --home "$HOME/.super-agent-demo"
```

`web` 会打印一条带随机访问令牌的 `http://127.0.0.1:.../#token=...` 链接。**打开链接即进入对话**；令牌只保存在该标签页的会话存储中，地址栏片段会被立即清除。链接失效（例如 Web 桥接重启）后重新运行 `web` 取新链接，不要在页面里填写模型密钥。

- 中间是唯一的主对话：直接说目标即可，不需要新建对话、选择会话或填写任务 ID。每条用户消息下直接显示实际路由动作和目标工作名称，例如“补充已有工作（未新建）”；补充“已受理”与 Worker 处理完成分开显示。一条消息可触发多个动作，失败或进度未知也明确展示。
- 每次新的回复、阶段交付、后台结果和通知都以独立消息块按创建顺序向下追加，不再挪到来源旧消息下。流式内容仅更新正在生成的那一块；点击“回应”来源引用可回看原消息，不改变消息顺序。
- 左下是后台工作列表（最近 80 项），只用于观察状态和停止；**点击它只改变右侧轨迹范围，不切换对话上下文**。
- 点击“查看本次路由与上下文”，右侧直接显示处理当时的工作状态、近期对话引用、实际动作和可选的 Router 公开说明。这是当时的上下文摘要，不是完整 SDK 上下文或私有思维链，也不会跟着当前任务状态改写；旧历史未采集的不补造。
- 右侧默认是**逐步过程**：按发生顺序一步一个实际调用，直接读出 Router 每次被触发的输入与公开说明、它调度到哪项工作，以及 Worker 的每个工具动作（文件、搜索词、命令、结果摘要、退出码）。同名工具的不同调用分开显示；开始与结果合并在同一步；每个步骤的完整记录可展开。打开一项工作时，从“Router 新建该工作”开始，到 Worker 动作、再到 Router 汇总交付，可连续读完。
- “因果线路”保留真实父子关系，“原始事件”保留逐条记录，两者用于核对；模型私有思维链不会出现在任何视图，未采集到的说明或结果明确标为缺失而不补造。默认从最近的记录开始并可加载更早步骤；未手动选定范围时跟随最新一轮，选定后不再自动跳走。按消息查看时只显示那一轮的决策、它创建的每项工作以及该轮的回复与交付，后续补充不会混进先前回合；按工作查看时只显示创建工作那一轮的决策和这项工作自身的记录，同一条消息创建的其它工作不会混入。展开的原始记录在实时更新时保持展开。
- 直接在对话中说“在 `/Users/你的用户名/project` 搜索登录逻辑，修改后运行测试”即可。Router 派发 Worker，自行列目录、搜索、按需读取和执行，不要求把文件或文件夹附带进去。
- “工作路径提示”是可选的初始位置提示，不是访问白名单。默认 cwd 为服务启动目录；Router 可依据对话指定目录，后续关联工作可显式指定 cwd，或使用当前路径提示、来源 cwd、服务启动目录，并读取当前文件。真实模式不再受整个项目 32 文件/1 MiB 的快照限制；单次工具输出仍采用 SDK 的分页/截断。真实模式会将读取的内容发送给模型供应商，不要让任务无关凭据进入上下文。
- 停止请求先返回请求状态，确认结算后才变为已取消；页面不会提前宣称停止成功。关闭页面或 Web 桥接不停止后台工作。

CLI 仍可脚本化：`submit` 创建后台任务，Web `chat` 写入主对话；两者共享任务、数据目录和轨迹，CLI 提交并非用户聊天消息。

## 环境与安装

- macOS 或 Linux，Node.js **22.19.0+**，本机提供 `/bin/bash`。
- 使用本地文件系统；不要让多个机器共享同一数据目录。
- Node 22 的 `node:sqlite` 可能输出实验性警告，属于当前运行时的预期提示。

```sh
npm ci
npm run build
npm run check
```

## 无密钥演示

终端一启动服务，保持此进程运行：

```sh
node dist/cli.js serve --mode offline --home "$HOME/.super-agent-demo"
```

终端二提交任务并查询：

```sh
node dist/cli.js submit --home "$HOME/.super-agent-demo" \
  --file ./README.md "概括这份文件"

# --file 也接受目录（同样适用展开后的文件数量和大小限制）
node dist/cli.js submit --home "$HOME/.super-agent-demo" \
  --file ./scripts/ "分析这个文件夹"

node dist/cli.js list --home "$HOME/.super-agent-demo"
node dist/cli.js get TASK_ID --home "$HOME/.super-agent-demo"
node dist/cli.js events --after 0 --home "$HOME/.super-agent-demo"
```

将 `TASK_ID` 替换为提交返回的 `id`。提交响应表示已持久接收，不表示分析已经完成；重复 `get` 可查看最终状态与 `report`。所有命令都输出 JSON。

**offline 输出带有 `[OFFLINE SIMULATION]`，只是调度演示，不做真实语义分析。** 它会通过实际执行器读取副本，并输出有限长度的输入/事件摘要。想观察并发、跟进或取消，可以先关闭服务，再用 `--offline-delay-ms 1000` 重启以拉长演示时间。

任务仍为 `queued` 或 `running` 时可以跟进：

```sh
node dist/cli.js followup TASK_ID "特别关注安装要求" --home "$HOME/.super-agent-demo"
node dist/cli.js stop TASK_ID --home "$HOME/.super-agent-demo"
```

`stop` 先返回停止请求状态；只有模型请求和后台操作确认结算后，任务才能成为 `cancelled`。无法证明操作结算时保持 `paused`。已完成、失败或已取消的任务不接受 CLI `followup`，但可以在主对话里继续追问：Router 会查阅已交付结果，需要再次执行时建立关联的新执行：完整本机服务创建 native 新执行（包括继续旧版 snapshot 任务），读取当前文件；仅 snapshot 服务复用已校验副本。暂停任务不能自动续跑，当前也没有 `resume` 命令。

## 真实模型

**启动 real 服务即启用完整本机工具权限。** 请使用专用账号或自行隔离不希望 Agent 访问的资源；工作目录不构成访问限制。

使用完整的 `@earendil-works/pi-coding-agent@1.5.0`。启动前显式设置以下环境变量：

- `SUPER_AGENT_PROVIDER`：SDK 中的供应商 ID，例如 `openai`。
- `SUPER_AGENT_MODEL`：该供应商的模型 ID，例如 `gpt-4o`；需要账户实际有权使用。
- `SUPER_AGENT_API_KEY`：通过安全的环境配置注入，不要放入提交内容、命令参数或仓库文件。

```sh
node dist/cli.js serve --mode real --home "$HOME/.super-agent-real"
```

也可以使用 PI SDK 内置的官方 `Sign in with ChatGPT`（`openai` OAuth）授权登录，无需配置 `SUPER_AGENT_API_KEY`（凭据与设备 ID 保存在对应 `--home` 下的 `sdk/auth.json` 和 `sdk/settings.json`）：

```sh
node dist/cli.js login openai --home "$HOME/.super-agent-real"
# 登录成功后直接启动（默认使用 openai / gpt-6.1-sol，也可通过 SUPER_AGENT_MODEL 指定如 gpt-6.1-terra）
node dist/cli.js serve --mode real --home "$HOME/.super-agent-real"
# 退出登录
node dist/cli.js logout openai --home "$HOME/.super-agent-real"
```

真实模式中，明确指定的文件内容会发送给配置的模型供应商。请只选择你允许发送的文件；不要把凭据或隐私文件当演示输入。

内置模型目录里可用的 DeepSeek 条目（`@earendil-works/pi-coding-agent@1.5.0`，无需自定义端点）：

```sh
export SUPER_AGENT_PROVIDER="deepseek"
export SUPER_AGENT_MODEL="deepseek-v4-pro"   # 或 deepseek-flash
```

两者为 `openai-completions` 接口、推理型模型，端点 `https://api.deepseek.com`。模型 ID 必须与目录一致；官方文档里的 `deepseek-chat` / `deepseek-reasoner` 不在该目录中，会直接报 `Unknown SDK model`，不会静默降级。本仓库尚未对任何外部供应商做过真实账户实测。

`serve` 默认使用 `real`；缺少配置、模型不存在或供应商请求失败会明确报错，**不会自动切换到 offline**。不同模式建议使用不同数据目录；每个任务也会记录接收时的模式。本项目不会读取 ThinkRail 的私有凭据。

## 输入与运行约束

- 真实模式新任务使用 `native` 执行：可不传 `--file`，也可用它提示初始工作路径；不预先读取或复制整个目录。没有按项目文件总数/字节限制，但仍有单次工具输出和模型上下文限制。
- `offline` 和旧 `snapshot` 任务继续使用只读副本：1–32 个展开后的 UTF-8 普通文件，每个 256 KiB、合计 1 MiB，拒绝符号链接、二进制、设备和可检测的复制时修改。旧记录和既有 Worker 不会被修改或重放，但在完整本机服务中继续它们产生的新执行必须使用 native，不能因为旧报告写着“无 shell”就降级。
- Bash 沿用 SDK 工具接口和输出格式，本机后端用 `/bin/bash` 和进程组执行、终止，区分真实信号退出与普通非零退出码；命令环境移除常见密钥变量。这不是凭据隔离或安全沙箱；同账号仍能读取本机文件。不要让 Agent 后台化或脱离管理地启动进程。
- 默认累计活跃执行时限为 600000 毫秒，可在提交时指定 `--limit-ms`（100–86400000）。定期检查约每 200 毫秒执行一次，结果交付前再次检查；停止确认可能更晚，时限不是实时调度或费用保证。
- 只有 snapshot 要求成功读取全部指定输入；native 按需读取，报告依据真实工具结果。最终报告最多 65536 字符，通知只保留摘要。
- 工具输出截断和副本字节限额不保证适配每个模型的上下文窗口；真实模型仍可能因上下文或账户限制失败。
- 任务数量、模型调用次数和总费用没有硬上限，数据目录也没有自动清理策略。

页面发送消息也携带请求标识：网络结果不明时草稿与标识会被保留，点击“重试原请求”复用同一标识，不会产生重复消息或重复副作用。CLI 可用 `--request-id ID` 重试同一次提交或跟进。参数一致则去重，使用同一 ID 改变参数会报错；不同 ID 表示不同请求。

## 状态、退出和恢复

默认数据目录为 `~/.super-agent`，`--home` 可选择其他**专用**目录。服务将其权限设为 `0700`，Socket 为 `0600`。路径过长会超出 Unix Socket 限制，请使用更短的目录。

```sh
node dist/cli.js health --home "$HOME/.super-agent-demo"
node dist/cli.js shutdown --home "$HOME/.super-agent-demo"
```

客户端命令退出不终止服务；`shutdown` 或服务进程收到 SIGINT/SIGTERM 时，会请求停止操作并保存暂停状态。执行器异常退出时，`health` 返回 `degraded`，查询与停止控制仍可用；不会自动重启执行器或重放任务。

native 工具执行前持久记录操作，正常返回后结算；停止时 SDK abort，但无法证明副作用的调用标记 unknown、任务保持 paused，而不是承诺取消成功。Bash 自身超时或异常信号退出也会立即暂停模型/工具循环，避免模型自动重试已经产生副作用的命令。已完成的文件修改不会回滚；服务崩溃或命令主动后台化后，不能保证所有子进程已终止。

重启服务保留已完成结果、事件游标和累计时间。对于意外退出时的在途任务，服务会暂停并说明进度不明；不会从 SDK 历史盲目重跑。崩溃后单实例锁最多需要约 10 秒过期，立即重启可能先报锁被占用；不要在旧进程仍存活时手工删除锁。

通知游标由调用方保存：读取 `events` 后，用最后一条 `seq` 作为下次 `--after`。尚无每客户端持久确认机制。

**数据以明文保存在本机**，包括文件副本、操作结果、提示与 SDK 会话历史。关闭服务且不再需要结果后，可自行删除专用数据目录及其已过期的同名 `.lock` 目录；不要把真实数据目录提交到 Git。

## 验证范围

```sh
npm run check
npm audit --omit=dev
```

测试覆盖实际 CLI/Socket、并发、跟进、取消确认、执行时限、重复提交、重启暂停、文件边界、执行器故障、SDK 工具白名单，以及主对话、工作关联、轨迹持久化与恢复。Web 桥接测试覆盖令牌校验、Host/Origin/跨站拒绝、请求大小限制、静态资源 CSP、SSE 游标补读，以及桥接重启后后台工作继续并保留同一对话。本机 OpenAI 兼容 SSE fixture 验证真实 SDK 的流式工具调用、检查点恢复、401 错误和取消，不需要外部 API。`test/native-tools.test.ts` 还实际调用七个工具完成搜索、读取、写入、编辑、运行命令，覆盖无附件派发、超过 32 个文件的目录、真实 cwd、密钥环境剥离、命令中断与保守恢复。

界面通过真实 Chrome 交互验证：无文件聊天、IME 回车不误发、模型/用户文本不被当成 HTML、按路径分析、因果节点与详情、工作选择不切换对话、突发消息全部注入、停止到确认取消、刷新与加载更早消息、768/390 断点与工作抽屉。该检查已随仓库提供：

```sh
node dist/cli.js web --home "$HOME/.super-agent-demo"      # 取它打印的链接
npm run check:browser -- "<链接>" --sample /绝对路径/示例.txt
```

需要 Node 22+、本机 Chrome/Edge，以及 tasteskill 的 CDP 助手（设 `CDP_HELPER` 指向其 `lib/cdp.mjs`，或保留默认路径）。它会向该数据目录真实提交消息，请指向演示目录。轨迹与消息排序等纯逻辑另有 `test/web-view.test.ts` 单元测试，无需浏览器。`test/routing.test.ts` 覆盖两个工作运行时的定向补充、多动作、失败动作、历史保存及阶段交付新消息 ID；恢复时不会把未确认的分配或补充处理编造成成功。`test/timeline.test.ts` 覆盖逐步过程的合并规则（同名工具独立、操作归入所属调用、同名步骤不重复）、缺失说明不补造、“最近窗口＋更早分页”无重叠无缺口，以及工作视图从创建它的 Router 决策开始。

**没有完成真实外部供应商账户的端到端实测，也没有验证任意脚本沙箱。** 故障测试使用 SIGSTOP/SIGCONT/SIGKILL；崩溃恢复测试通过老化锁时间戳模拟锁已过期，不改变任务状态。
