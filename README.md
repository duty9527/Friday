# <img src="assets/logo.png" width="36" align="top" alt="F.R.I.D.A.Y. Logo"> F.R.I.D.A.Y.

**本地常驻的个人全天候 AI 战术副手（Router / Worker 协同系统）**

你永远只面对**同一个持续在线的声音（F.R.I.D.A.Y.）**——无论在微信、小爱音箱、Web 控制台还是终端 TUI 中，无需新建会话、无需管理后台任务 ID。主脑（Router）负责持续对话、全局记忆联想与结果验收；耗时编码、代码审查、深度调研与自动化任务则交由后台隔离的专职子 AI（Workers）并发推进。

---

## 核心特性

- **单一持续对话 + 质量门禁（Router / Worker 双层架构）**
  - 用户只与 Router 自然对话；Router 自动编译上下文简报（Context Brief），按任务类型派发 `coding` / `research` / `review` / `general` 专职子 AI。
  - 子 AI 拥有完整本机工具权限（`read` / `ls` / `find` / `grep` / `bash` / `edit` / `write`）；同工作区并发执行时自动感知同伴态势（`concurrentPeers`）。
  - 子 AI 完成汇报时，Router 先作为**质量门禁（Quality Gate）**核验结果，发现遗漏自动打回补查，合格后再向你交付。
- **盘中战术请示（`ASK_BOSS`）**
  - 子 AI 遇到高危不可逆操作或关键业务分岔时可原地挂起请示（挂起期间不消耗活跃执行时限），经由当前渠道（如微信、小爱音箱、Web）推送问题；你在对话中随口拍板即可唤醒原会话继续执行。
- **三层全息神经记忆 + 语义蒸馏（Semantic & Distiller）**
  - **L0 元记忆目录** + **L2 语义记忆卡片** + **L1 情景对话与任务历史**。
  - 每次发言前自动触发**潜意识记忆闪回（`autoRecalled`）**；融合混合关键词与本地向量语义检索、赫布突触共激活权重（`synapses`）、艾宾浩斯遗忘衰减、海马体蒸馏器自动巩固，以及同主题旧记忆新陈代谢（`supersededBy`）。
  - 支持交互式全息脑图视图（`mindmap`）检视记忆网络与因果轨迹。
- **双过程潜意识睡眠与做梦**
  - 基于人类睡眠的 Borbély 双过程模型（稳态睡眠压力 `S` × 昼夜节律 `C`），在系统静默空闲且积累未消化经历时自然入睡（无需也无法手动触发）。
  - **NREM 慢波阶段**执行本地突触修剪与记忆整合；**REM 快速眼动阶段**以只读工具（`read`/`ls`/`find`/`grep`）漫游本地代码库，做跨领域联想印证。
  - 遵循真实梦境遗忘曲线（半衰期 12 分钟、最多保留 2 轮对话余温），任何新消息到达时 **50ms 内瞬时惊醒**。
- **异构模型池（Model Hub & Pool）**
  - 支持 `openai`（含 ChatGPT OAuth 免 Key 登录）、`deepseek`、`anthropic`、`google`、`dashscope`、`openrouter`、`ollama` 等多提供商配置，支持用户自定义模型池、连通性/视觉探针，以及按任务复杂度动态路由模型与原生思考等级。
- **全渠道 IM 网关与小爱语音栈**
  - **微信个人号（iLink 扫码绑定）**：支持微信拆条消息与图片智能聚合、真实视觉看图、生成文档后自动通过 `send_file` 发送附件，以及严格的来源会话路由隔离（Exact-Origin Routing）；同时支持钉钉与 Telegram。
  - **小爱音箱语音栈（XiaoAI）**：支持路由器桥接（`scripts/xiaoai-router-bridge.sh`）、局域网 SSH 直连与 KWS 连续对话，内置本地 CAM++ 声纹识别门禁与尾音防串音裁剪，避免电视背景音误触发。
- **全能扩展插件与定时器**
  - 内置 6 个原生插件：`system-pulse`（主机/工作区脉搏诊断与静默巡检）、`fund-tracker`（基金持仓盘中估值与晚间净值结算）、`tv-ir`（红外电视遥控与连续遥控快通）、`tv-agent`（Android TV 无障碍控制与 DLNA 投屏）、`miot`（米家本地设备与 BLE Mesh / MiIO 直控）与 `health-scale`（蓝牙体脂秤采集与健康趋势分析）。
  - 支持 `--daily-at` 定点巡航、`--delay-ms --once` 一次性倒计时提醒，以及在 `~/.friday/plugins/` 下自建扩展插件（`friday` CLI 在守护进程在线时自动走 Daemon RPC，离线时受 `privateHome` 校验本地执行）。

---

## 快速开始

### 1. 环境与安装

需要 **macOS / Linux** 与 **Node.js >= 22.19.0**。

```bash
npm ci
npm run build
```

### 2. 登录或配置模型

可通过 OpenAI OAuth 授权登录（凭据保存在 `~/.friday/sdk/auth.json`），或配置环境变量 / Model Hub（同时向后兼容 `SUPER_AGENT_*` 环境变量与历史目录）：

```bash
# 方式 A：OAuth 扫码/浏览器登录
node dist/cli.js login openai

# 方式 B：环境变量指定供应商与模型
export FRIDAY_PROVIDER="deepseek"
export FRIDAY_MODEL="deepseek-chat"
export FRIDAY_API_KEY="sk-..."
```

### 3. 启动服务与交互入口

```bash
# 终端 1：启动常驻协调守护进程（默认数据目录 ~/.friday，可用 FRIDAY_HOME 或 --home 覆盖）
node dist/cli.js serve --mode real

# 终端 2：启动本地 Web 指挥台（打印带一次性访问令牌的 127.0.0.1 链接）
node dist/cli.js web --port 3210

# 或启动终端交互式 TUI（支持跨端消息同步与 8 位短 ID 控制）
node dist/cli.js tui

# 或启动独立 Watchdog 监护（自动重连与受限重启服务）
node dist/cli.js watchdog --mode real --interval-ms 2000 --max-retries 3
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
node dist/cli.js model set --provider deepseek --api-key "sk-..." --worker-provider deepseek --fast deepseek-chat --strong deepseek-reasoner
node dist/cli.js model probe deepseek/deepseek-chat

# 定时器与插件
node dist/cli.js plugin list
node dist/cli.js plugin run system-pulse status
node dist/cli.js timer add --name "午间估值" --daily-at 12:00 --plugin fund-tracker --action noon
node dist/cli.js timer add --name "喝水提醒" --delay-ms 1800000 --once --plugin system-pulse --action remind
node dist/cli.js timer toggle <TIMER_ID>              # 省略开关参数时自动在服务端翻转当前状态

# 小爱声纹管理
node dist/cli.js voice status
node dist/cli.js voice config --threshold 0.48 --wake-precheck

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
│   ├── decision.ts         # 任务路由、模型池调度与完成质量评估
│   ├── store.ts            # SQLite 持久化层：三层神经记忆、突触权重、语义检索与任务账本
│   ├── distiller.ts        # 记忆蒸馏器：睡眠巩固、摘要提纯与旧记忆代谢
│   ├── semantic.ts         # 本地嵌入与语义混合检索
│   ├── model-hub.ts        # 异构模型池：多提供商管理、探针与候选模型调度
│   ├── mindmap-flow.ts     # 全息脑图快照与因果脉络构建
│   ├── im/ & im.ts         # 全渠道 IM 网关（微信 iLink / 钉钉 / Telegram / 小爱）
│   ├── xiaoai-*.ts         # 小爱音箱接入、KWS 连续对话、CAM++ 声纹门禁与语音流处理
│   ├── wechat-*.ts         # 微信入站媒体解密、出站附件上传与消息编解码
│   ├── plugin.ts           # 凭据隔离的本地插件运行器与视图脱敏
│   ├── paths.ts            # 统一数据目录（~/.friday）与环境变量解析（FRIDAY_* / 兼容前缀）
│   ├── server.ts & protocol.ts # Unix Socket 守护进程、分阶段超时控制与 RPC 协议
│   ├── watchdog.ts         # 独立 Watchdog 探测、受限重启与 watchdog.json 状态持久化
│   ├── web-server.ts & web/ # 本地 Web 指挥台前端（含脑图与插件面板）与 SSE 实时桥接
│   ├── tui.ts              # 终端交互式全息控制台
│   └── cli.ts              # CLI 命令行入口
├── plugins/
│   ├── system-pulse/       # 主机/工作区脉搏诊断、异常静默巡航与零 Token 提醒插件
│   ├── fund-tracker/       # 基金持仓实时估值与晚间正式净值结算插件
│   ├── tv-ir/              # 小爱 Pro 红外电视遥控与连续快通插件
│   ├── tv-agent/           # Android TV 无障碍 Agent、DLNA 投屏与多模态导航插件
│   ├── miot/               # 米家本地中枢、BLE Mesh 与局域网 MiIO 设备直控插件
│   └── health-scale/       # 蓝牙体脂秤数据采集与健康趋势分析插件
├── docs/                   # 架构说明、IM/语音接入指南与参考资料
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
