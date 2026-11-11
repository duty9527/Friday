# F.R.I.D.A.Y.

**本地常驻的个人全天候 AI 战术副手（Router / Worker 协同系统）**

你永远只面对**同一个持续在线的声音（F.R.I.D.A.Y.）**——无论在微信、Web 控制台还是终端 TUI 中，无需新建会话、无需管理后台任务 ID。主脑（Router）负责持续对话、全局记忆联想与结果验收；耗时编码、代码审查、深度调研与自动化任务则交由后台隔离的专职子 AI（Workers）并发推进。

---

## 核心特性

- **单一持续对话 + 质量门禁（Router / Worker 双层架构）**
  - 用户只与 Router 自然对话；Router 自动编译上下文简报（Context Brief），按任务类型派发 `coding` / `research` / `review` / `general` 专职子 AI。
  - 子 AI 拥有完整本机工具权限（`read` / `ls` / `find` / `grep` / `bash` / `edit` / `write`）；同工作区并发执行时自动感知同伴态势（`concurrentPeers`）。
  - 子 AI 完成汇报时，Router 先作为**质量门禁（Quality Gate）**核验结果，发现遗漏自动打回补查，合格后再向你交付。
- **盘中战术请示（`ASK_BOSS`）**
  - 子 AI 遇到高危不可逆操作或关键业务分岔时可原地挂起请示（挂起期间不消耗活跃执行时限），经由当前渠道（如微信）推送问题；你在对话中随口拍板即可唤醒原会话继续执行。
- **三层全息神经记忆**
  - **L0 元记忆目录** + **L2 语义记忆卡片** + **L1 情景对话与任务历史**。
  - 每次发言前自动触发**潜意识记忆闪回（`autoRecalled`）**；支持赫布突触共激活权重（`synapses`）、艾宾浩斯遗忘衰减、海马体任务经验自动巩固，以及同主题旧记忆自动新陈代谢（`supersededBy`）。
- **双过程潜意识睡眠与做梦**
  - 基于人类睡眠的 Borbély 双过程模型（稳态睡眠压力 `S` × 昼夜节律 `C`），在系统静默空闲且积累未消化经历时自然入睡（无需也无法手动触发）。
  - **NREM 慢波阶段**执行本地突触修剪与记忆整合；**REM 快速眼动阶段**以只读工具（`read`/`ls`/`find`/`grep`）漫游本地代码库，做跨领域联想印证。
  - 遵循真实梦境遗忘曲线（半衰期 12 分钟、最多保留 2 轮对话余温），任何新消息到达时 **50ms 内瞬时惊醒**。
- **异构模型中枢（Model Hub）**
  - 支持 `openai`（含 ChatGPT OAuth 免 Key 登录）、`deepseek`、`anthropic`、`google`、`dashscope`、`openrouter` 等多提供商配置，按 `fast` / `balanced` / `strong` 三档动态调度子 AI 模型。
- **全渠道 IM 网关与自进化插件**
  - **微信个人号（iLink 扫码绑定）**：支持微信拆条消息与图片智能聚合、真实视觉看图、生成文档后自动通过 `send_file` 发送附件，以及严格的来源会话路由隔离（Exact-Origin Routing）；同时支持钉钉与 Telegram。
  - **插件与定时器**：内置 `system-pulse`（主机/工作区脉搏诊断与静默巡检）与 `fund-tracker`（基金午间估值与晚间结算），支持 `--daily-at` 定点巡航、`--delay-ms --once` 一次性倒计时提醒，以及在 `~/.super-agent/plugins/` 下自建扩展插件。

---

## 快速开始

### 1. 环境与安装

需要 **macOS / Linux** 与 **Node.js >= 22.19.0**。

```bash
npm ci
npm run build
```

### 2. 登录或配置模型

可通过 OpenAI OAuth 授权登录（凭据保存在 `~/.super-agent/sdk/auth.json`），或配置环境变量 / Model Hub：

```bash
# 方式 A：OAuth 扫码/浏览器登录
node dist/cli.js login openai

# 方式 B：环境变量指定供应商与模型
export SUPER_AGENT_PROVIDER="deepseek"
export SUPER_AGENT_MODEL="deepseek-v4-pro"
export SUPER_AGENT_API_KEY="sk-..."
```

### 3. 启动服务与交互入口

```bash
# 终端 1：启动常驻协调守护进程（默认数据目录 ~/.super-agent）
node dist/cli.js serve --mode real

# 终端 2：启动本地 Web 指挥台（打印带一次性访问令牌的 127.0.0.1 链接）
node dist/cli.js web --port 3210

# 或启动终端交互式 TUI
node dist/cli.js tui
```

### 4. 绑定微信个人号（可选）

```bash
node dist/cli.js im login
```

终端会直接渲染二维码，使用手机微信扫码确认后即可在微信中与 F.R.I.D.A.Y. 实时对话、收发图片与文件附件。

---

## 常用 CLI 命令

```bash
# 全局态势简报（健康状态、活跃工作、记忆目录、定时器、插件、IM 通道）
node dist/cli.js brief

# 记忆管理
node dist/cli.js memory list
node dist/cli.js memory search "关键词"
node dist/cli.js memory save --topic "架构规范" "具体内容" --tag arch --pinned

# 模型中枢配置与连通性探针
node dist/cli.js model list
node dist/cli.js model set --provider deepseek --api-key "sk-..." --fast deepseek-flash --strong deepseek-v4-pro
node dist/cli.js model probe deepseek/deepseek-flash

# 定时器与插件
node dist/cli.js plugin list
node dist/cli.js plugin run system-pulse status
node dist/cli.js timer add --name "午间估值" --daily-at 12:00 --plugin fund-tracker --action noon
node dist/cli.js timer add --name "喝水提醒" --delay-ms 1800000 --once --plugin system-pulse --action remind

# 任务控制与服务生命周期
node dist/cli.js list
node dist/cli.js stop <TASK_ID>
node dist/cli.js resume <TASK_ID>
node dist/cli.js health
node dist/cli.js shutdown
```

---

## 目录结构

```text
├── src/
│   ├── agent.ts            # Router / Worker / Dreamer 会话工厂、提示词与安全工具集
│   ├── coordinator.ts      # 核心调度器：任务编排、潜意识睡眠/做梦循环、定时器与质检门禁
│   ├── store.ts            # SQLite 持久化层：三层神经记忆、突触权重、任务与状态账本
│   ├── model-hub.ts        # 异构模型中枢：多提供商管理、探针与 fast/balanced/strong 路由
│   ├── im.ts               # 全渠道 IM 网关（微信 iLink / 钉钉 / Telegram）与消息聚合
│   ├── wechat-inbound.ts   # 微信入站图片/文件 AES-128-ECB 解密与安全落地
│   ├── wechat-file.ts      # 微信出站附件 CDN 上传与投递
│   ├── plugin.ts           # 凭据隔离的本地插件运行器
│   ├── trace.ts            # 因果轨迹与逐步过程记录（自动剥离潜意识内部状态）
│   ├── server.ts           # Unix Socket 守护进程与 RPC 服务端
│   ├── web/                # 本地 Web 指挥台前端与 SSE 实时桥接
│   ├── tui.ts              # 终端交互式全息控制台
│   └── cli.ts              # CLI 命令行入口
├── plugins/
│   ├── system-pulse/       # 主机/工作区脉搏诊断、异常静默巡航与零 Token 提醒插件
│   └── fund-tracker/       # 基金持仓实时估值与晚间正式净值结算插件
└── test/                   # 端到端与单元验证套件（npm run check）
```

详细架构与设计边界请参阅 [architecture.md](architecture.md) 与 [goal-and-requirements.md](goal-and-requirements.md)。

---

## 开发与测试

```bash
npm run check
```

---

## License

本项目基于 [MIT License](LICENSE) 开源。
