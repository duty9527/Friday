# Super-agent

本地常驻、具有完整本机编码工具的 Router/Worker Agent。用户只面对**一个持续对话**：交流、追加要求、派发新工作都在同一处，后台多个 Worker 并发执行，右侧展示可回看的执行轨迹。

**真实模式默认开放受信任本机工具：read / ls / find / grep / bash / edit / write。** 可以按需搜索读取、修改真实文件、执行命令和测试，无需附件。命令以服务账号运行，工作目录不是沙箱，可访问目录外、联网、安装依赖和执行破坏性操作；没有逐条审批、自动回滚或同目录并发写入保护。离线模拟仍为只读副本流程。尚无定时任务、Watchdog、TUI 或自动发现 MCP/扩展。目标和实现边界见 [目标规格](goal-and-requirements.md) 与 [架构规格](architecture.md)。

## 主对话与执行轨迹

先在终端一启动协调服务（下面用 offline 演示），再在终端二启动本地 Web：

```sh
node dist/cli.js serve --mode offline --home "$HOME/.super-agent-demo"
node dist/cli.js web --home "$HOME/.super-agent-demo"
```

`web` 会打印一条带随机访问令牌的 `http://127.0.0.1:.../#token=...` 链接。**打开链接即进入对话**；令牌只保存在该标签页的会话存储中，地址栏片段会被立即清除。链接失效（例如 Web 桥接重启）后重新运行 `web` 取新链接，不要在页面里填写模型密钥。

- 中间是唯一的主对话：直接说目标即可，不需要新建对话、选择会话或填写任务 ID。
- 左下是后台工作列表（最近 80 项），只用于观察状态和停止；**点击它只改变右侧轨迹范围，不切换对话上下文**。
- 右侧是执行轨迹：按消息或工作查看因果线路、事件时间线、节点公开数据与状态。并行 Worker 显示为分支；模型私有思维链不会出现，未采集到的历史细节显示为缺失而不补造。
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

需要 Node 22+、本机 Chrome/Edge，以及 tasteskill 的 CDP 助手（设 `CDP_HELPER` 指向其 `lib/cdp.mjs`，或保留默认路径）。它会向该数据目录真实提交消息，请指向演示目录。轨迹与消息排序等纯逻辑另有 `test/web-view.test.ts` 单元测试，无需浏览器。

**没有完成真实外部供应商账户的端到端实测，也没有验证任意脚本沙箱。** 故障测试使用 SIGSTOP/SIGCONT/SIGKILL；崩溃恢复测试通过老化锁时间戳模拟锁已过期，不改变任务状态。
