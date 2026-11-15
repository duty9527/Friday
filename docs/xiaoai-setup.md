# F.R.I.D.A.Y. × 小爱音箱（XiaoAI）接入实操手册

本手册面向 **OH2P（免拆机 Type-C）**、**LX06（拆底盖 6 颗螺丝 Micro-USB 免焊接）**、**已 Root 的小米 BE6500 Pro 路由器** 与 **Mac 主机** 的家庭网络环境，提供三种零第三方重依赖的原生接入方案。

---

## 设备与前置准备

| 设备 | 接入特性 | 建议固定局域网 IP（示例） |
| :--- | :--- | :--- |
| **Mac 主机** | 运行 `friday serve` 常驻守护进程，建议路由器绑定静态 IP 并开启网卡唤醒（WOL） | `192.168.31.100` |
| **小爱音箱 OH2P** | 机身自带 Type-C 调试口，**免拆机** 刷入/开启 Dropbear SSH | `192.168.31.101` |
| **小爱音箱 LX06** | 撕开底部防滑垫卸下 **6 颗螺丝**，主板自带 **Micro-USB** 口，**免焊接** 开启 SSH | `192.168.31.102` |
| **BE6500 Pro 路由器** | 已获取 Root SSH 权限，7×24 小时在线，可承载桥接监听与 Mac 休眠唤醒 | `192.168.31.1` |

> **音箱原生特性说明**：F.R.I.D.A.Y. 接收到命中指令后会立即通过 `ubus call mediaplayer player_play_operation '{"action":"pause"}'` 打断小爱原生抢答，随后将回复自动清洗为口语文本并分段通过 TTS 精准播报回**发起提问的那台音箱**。

---

## 模式一（推荐主力）：双音箱局域网 SSH 直连（低延迟 / 离线可用）

### 1. 配置 Mac 到双音箱的 SSH 免密登录

音箱开启 SSH 后，将 Mac 本机公钥写入两台音箱的 `/etc/dropbear/authorized_keys`（部分固件为 `/root/.ssh/authorized_keys`）：

```bash
# 若 Mac 尚未生成公钥，先执行：ssh-keygen -t ed25519
PUB_KEY=$(cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub)

# 写入 OH2P 与 LX06（音箱旧版 Dropbear 需启用 ssh-rsa 兼容参数）
for host in root@192.168.31.101 root@192.168.31.102; do
  ssh -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa "$host" \
    "mkdir -p /etc/dropbear && echo '$PUB_KEY' >> /etc/dropbear/authorized_keys && chmod 600 /etc/dropbear/authorized_keys"
done
```

验证免密连通（不弹窗输密码即成功）：

```bash
ssh -o BatchMode=yes -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa root@192.168.31.101 "echo OH2P_OK"
ssh -o BatchMode=yes -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa root@192.168.31.102 "echo LX06_OK"
```

### 2. 一行命令接入 F.R.I.D.A.Y.

```bash
friday im add --platform xiaoai --name "家里小爱" --api-base "ssh://oh2p=root@192.168.31.101,lx06=root@192.168.31.102"
```

- **可选触发前缀过滤**：若希望只有说出特定前缀（如“星期五”或“Friday”）才交给 F.R.I.D.A.Y.，其余对话全交回小爱原生助手，可在地址末尾附加 `?prefix=星期五,Friday`：
  ```bash
  friday im add --platform xiaoai --name "家里小爱" --api-base "ssh://oh2p=root@192.168.31.101,lx06=root@192.168.31.102?prefix=星期五,Friday"
  ```
- **未设前缀时的智能放行**：F.R.I.D.A.Y. 默认放行“音量大一点 / 暂停 / 闭嘴 / 定个闹钟”等本机控制指令，仅拦截自然语言问答与任务指令。
- 也可在 Web 控制台「📱 IM 远端接入 → 手动配置通道」中选择 **🔊 小爱音箱 (XiaoAI)**，在「API / SSH 地址」栏填入上述 `ssh://...` 字符串保存。

---

## 模式二（免拆免刷尝鲜）：小米云端轮询（MiNA API）

如果不方便开启音箱 SSH，可准备一个**小米小号**，在米家 App 中将音箱通过「家庭共享」分享给该小号后，使用小米云轮询接入：

```bash
friday im add --platform xiaoai --name "小爱云端" \
  --account-id "你的小米小号ID" \
  --bot-token "你的小米小号密码"
```

- **高阶凭证模式**：若已有 MiNA 抓包凭证，也可将 `--bot-token` 设为 JSON 字符串：
  `{"userId":"...","serviceToken":"...","ssecurity":"...","deviceId":"...","hardware":"OH2P"}`。
- F.R.I.D.A.Y. 首次轮询会自动建立对话时间戳基线，**不会重放历史对话**；后续新语音指令将按轮询间隔拉取并原路 TTS 播报回原设备。

---

## 模式三：BE6500 Pro 路由器桥接 + Mac 休眠自动唤醒

当 Mac 平时处于休眠省电状态时，可将仓库自带的 [`scripts/xiaoai-router-bridge.sh`](../scripts/xiaoai-router-bridge.sh) 部署到 7×24 小时运行的 **BE6500 Pro 路由器** 上，实现“语音指令触发 → 路由器自动发 WOL 魔术包唤醒 Mac → 音箱播报提示 → 投递给 F.R.I.D.A.Y.”的无缝闭环。

### 1. 在 F.R.I.D.A.Y. 创建 Webhook 通道

```bash
friday im add --platform xiaoai --name "路由器桥接" \
  --secret "你的自定义密钥" \
  --webhook-url "http://192.168.31.101:18080/tts"
```

执行 `friday im list` 记下生成的通道 `id`（例如 `im_xxx`），Web 端对应的入站回调路径为 `/im/webhook/<通道ID>`（请求头需携带 `x-xiaoai-secret: 你的自定义密钥`）。

> 若仅需路由器唤醒 Mac 后由 F.R.I.D.A.Y. 本机执行任务、且出站仍通过 SSH 直接向音箱播报，也可配置为由桥接脚本监听并投递，出站由模式一 SSH 通道或路由器本地轻量 HTTP TTS 接收端完成。

### 2. 在 BE6500 Pro 路由器部署桥接脚本

将脚本复制到路由器（如 `/data/xiaoai-router-bridge.sh`）并赋予执行权限：

```sh
chmod +x /data/xiaoai-router-bridge.sh
```

配置环境变量启动监听（以监听 OH2P 并唤醒 Mac 为例）：

```sh
FRIDAY_WEBHOOK_URL="http://192.168.31.100:<WEB端口>/im/webhook/<通道ID>" \
FRIDAY_SECRET="你的自定义密钥" \
SPEAKER_HOST="root@192.168.31.101" \
MAC_WOL_MAC="AA:BB:CC:DD:EE:FF" \
MAC_PING_HOST="192.168.31.100" \
TRIGGER_PREFIX="星期五,Friday" \
POLL_INTERVAL=1 \
/data/xiaoai-router-bridge.sh
```

**脚本行为说明**：
1. 启动时先读取 `/tmp/mico_aivs_lab/instruction.log` 最新一行建立游标基线，避免重启重复触发历史语音；
2. 捕获到匹配 `TRIGGER_PREFIX` 的最终语音识别文本后，立刻向音箱发送 `pause` 掐断原生抢答；
3. 若检测到 `MAC_PING_HOST` 休眠不可达，自动通过 `ether-wake` / `python3` / `nc` 广播 Wake-on-LAN 魔术包唤醒 Mac，并让音箱先播报：**“正在为您唤醒星期五主机，请稍候”**；
4. 待 Mac 网络恢复（最多等待 15 秒）后，将语音指令连同 `x-xiaoai-secret` 头 POST 到 `FRIDAY_WEBHOOK_URL`。

---

## 常用指令与跨设备联动

### 1. 通道列表与语音自检

```bash
# 查看所有 IM 与语音通道状态
friday im list

# 触发小爱音箱口语化自检播报（将 <通道ID> 替换为 list 输出的 id）
friday im test <通道ID>
```

### 2. 定时早报 / 定时播报到小爱音箱

```bash
# 每天早上 08:00 自动总结待办与项目进展并推送到小爱音箱播报
friday timer add --name "每日早报" --daily-at 08:00 --channel xiaoai \
  "汇总今日核心待办、持仓或项目状态，控制在 3 句话以内用口语播报"
```

在 Web 控制台「⏰ 定时任务」弹窗中创建任务时，也可直接在「投递端口」输入框填写 `xiaoai`（或具体的通道 ID）。

### 3. 对话中跨设备切换（“用小爱回复”）

在 **Web 控制台** 或 **微信对话** 中，当你想让 F.R.I.D.A.Y. 的答复直接从客厅音箱念出来，只需在问题末尾加上指令，例如：

- `帮我查一下今天基金估值，这条用小爱回复`
- `把刚才的分析总结一下，在小爱音箱回复`

主控 Router 会自动调用 `switch_channel` 工具将本轮交付通道切换至 `xiaoai`，并将答案清洗为自然中文口语推送至小爱音箱朗读。

### 4. 红米/小米电视红外遥控（`tv-ir` 插件 × `LX06`）

只要已接入具备红外发射能力的小爱音箱 Pro（`LX06`），即可通过内置 `tv-ir` 插件（底层复用 `ubus call ir_agent` 与 Xiaomi 20-bit 4-PPM 协议）在微信、Web 或小爱语音中毫秒级遥控红米/小米电视：

- **支持的预设按键**：`up`（上）、`down`（下）、`left`（左）、`right`（右）、`ok`（确认/点击）、`back`（返回）、`menu`（菜单）、`home`（主页）、`vol_up`（音量+）、`vol_down`（音量-）、`power`（电源）、`power_alt`（备用电源）。
- **CLI 快速测试**：
  ```bash
  # 检查 LX06 红外服务与自动发现状态
  friday plugin run tv-ir status

  # 查看全部预设与已学习按键
  friday plugin run tv-ir keys

  # 发送单键 / 连发 / 组合按键序列
  friday plugin run tv-ir press --args '{"key":"menu"}'
  friday plugin run tv-ir press --args '{"key":"down","count":3}'
  friday plugin run tv-ir sequence --args '{"keys":["down","down","right","ok"]}'

  # 学习物理遥控器按键（对准 LX06 按下按键，支持新增自定义键或覆盖预设键）
  friday plugin run tv-ir learn --args '{"key":"source","label":"信号源","timeoutMs":12000}'
  ```
- **语音单次与极速零路由连续遥控**：
  - 单次操控：直接对小爱喊 **“星期五，帮我点一下电视菜单”** 或 **“星期五，电视往下按两下再确认”**；
  - 极速连续遥控模式：喊 **“星期五，遥控电视模式”**（或 **“进入遥控电视模式，先按一下菜单”**），音箱播报 `"已进入遥控模式"` 后进入**本地零模型 / 零 TTS 直通模式**：后续所有按键词由网关本地确定性解析并毫秒级直发 `LX06` 红外码（不再经过大模型路由，也不阻塞播报确认音），且在 **60 秒空闲超时前持续保持免唤醒监听**（期间环境噪音或空识别会自动续接监听，不会中途掉线）；
  - 模式内固定操作词示例：
    - **方向/连按**：`上 / 向上 / 往上`、`下 / 向下 / 往下`、`左 / 向左 / 往左`、`右 / 向右 / 往右`，支持连按如 `往下三下`、`往右两格`、`下下`、`往下按一个`；
    - **功能键**：`确认 / 确定 / 点击 / 回车 / 暂停 / 播放`、`返回 / 后退 / 上一页`、`菜单 / 设置`、`主页 / 首页 / 桌面`；
    - **音量与电源**：`音量加 / 大声一点 / 音量加三格`、`音量减 / 小声一点`、`开电视 / 关电视 / 电源`；
    - **组合动作**：`往下两下再确认`、`返回然后主页`；
    - **退出模式**：说 **“退出遥控”** / **“退出”** / **“好了”** / **“不用了”**（或静置 60 秒无有效操作）即自动退出遥控模式并恢复常驻唤醒待机。

### 5. 红米/小米电视智能 Agent（tv-agent 插件）

在 `tv-ir` 红外遥控的基础上，配合电视端安装的无障碍 HTTP Agent（`local.friday.tvagent`，监听 `:8989`）与电视自带 DLNA/UPnP 服务（`:49152`），`tv-agent` 可实现应用直达、精确音量控制、DLNA 投屏、幂等开关机（仅状态不符时才回退 `tv-ir` 发电源键）及由 `gemini-decision-1` 驱动的多步界面树 + 截图多模态自主导航：

- **CLI 快速测试**：
  ```bash
  # 查看电视在线状态、前台应用、a11yBound 与精确音量
  friday plugin run tv-agent status

  # 幂等开关机（已开机时仅唤醒不发红外，关机时发红外电源并轮询上线）
  friday plugin run tv-agent power --args '{"state":"on"}'

  # 精确设置或相对调整音量 / 静音
  friday plugin run tv-agent volume --args '{"level":15}'
  friday plugin run tv-agent volume --args '{"delta":-5}'

  # 毫秒级启动应用（支持别名 bili/smarttube/live/tvbox/hdbox/home 或包名）
  friday plugin run tv-agent open_app --args '{"app":"bili"}'

  # DLNA 投屏播放与进度控制
  friday plugin run tv-agent cast --args '{"op":"play","url":"http://192.168.31.100:8080/video.mp4","title":"测试视频"}'

  # 多步自主导航（自动打开应用、读界面树并在必要时截图决策）
  friday plugin run tv-agent navigate --args '{"app":"bili","goal":"搜索周杰伦并播放第一条视频","searchText":"周杰伦"}'
  ```
- **小爱语音示例**：
  - **“星期五，把电视音量调到 15”**
  - **“星期五，打开电视 B 站搜周杰伦”**
  - **“星期五，帮我把电视关了”**

### 6. 全屋米家设备发现与本地直控（miot 插件 × BE6500 Pro 中枢）

`miot` 插件直接对接家庭本地中枢与局域网设备，不依赖外网云端长链路即可秒级发现并操控全屋米家设备：

- **四层本地协同架构**：
  1. **中枢设备发现（BE6500 Pro SQLite）**：通过 SSH 读取小米 BE6500 Pro 路由器中枢数据库，自动发现全屋房间、设备列表与属性映射；
  2. **BLE Mesh 实时直控（MIPS MQTT `local/bt/rpcReq`）**：在中枢侧通过本地 MQTT RPC 主题读写蓝牙 Mesh 灯具、开关与插座状态（如 `卧室灯`、`鱼缸灯`、`乌龟灯`）；
  3. **局域网 MiIO UDP 直连（`:54321`）**：对支持局域网 MiIO 协议的设备（如空气炸锅 `careli.fryer.maf01`）直接走 UDP `:54321` 查询剩余时间、当前状态并下发烹饪参数；
  4. **小爱静默 NLP 回退（LX06 `mibrain ai_service`）**：针对空调红外码或复合自然语言控制，通过 `LX06` 本地 `mibrain ai_service` 静默执行语义指令（不触发额外音箱抢答）。
- **CLI 快速测试**：
  ```bash
  # 检查 BE6500 Pro 中枢与 LX06 音箱 SSH 连通性
  friday plugin run miot status

  # 发现全屋设备与房间拓扑（live=true 实时拉取 BLE Mesh 与空气炸锅 UDP 状态）
  friday plugin run miot devices --args '{"live":true}'

  # 查询单个设备实时状态（如灯光开关、空气炸锅剩余时间）
  friday plugin run miot get --args '{"device":"空气炸锅"}'

  # 控制灯具/开关/插座（支持 on/toggle）与带房间前缀的红外空调
  friday plugin run miot set --args '{"device":"卧室灯","on":true}'
  friday plugin run miot set --args '{"device":"鱼缸灯","on":false}'
  friday plugin run miot set --args '{"device":"卧室空调","temperature":26}'

  # 控制空气炸锅（careli.fryer.maf01：40-200°C、1-1440 分钟、预设 薯条/鸡翅/蛋挞/手动）
  friday plugin run miot cook --args '{"op":"start","tempC":180,"minutes":10,"recipe":"薯条"}'
  friday plugin run miot cook --args '{"op":"pause"}'

  # 通过 LX06 小爱静默执行自然语言指令
  friday plugin run miot command --args '{"text":"打开客厅空调"}'
  ```
- **小爱语音与定时联动示例**：
  - 状态查询：**“星期五，家里哪些灯开着”**、**“星期五，空气炸锅还剩几分钟”**
  - 设备控制：**“星期五，打开卧室灯”**、**“星期五，关掉鱼缸灯”**、**“星期五，空气炸锅 180 度 10 分钟”**
  - 房间消歧：**“星期五，把卧室空调调到 26 度”**（若只说“开空调”未指定房间，音箱会简短追问 *“要开客厅空调还是卧室空调？”* 并保持免唤醒监听）
  - 定时自动化：可在对话中直接要求“每天晚上 11 点关掉鱼缸灯”，Router 会通过 `manage_timer` 绑定 `plugin: "miot"` 自动定时执行。

### 7. 多人音色识别与防电视串音（本地声纹门禁）

在电视旁放置小爱音箱且开启 `?kws=1` 时，可为自己和家人录入声纹；电视人物说话、播广告误触“星期五”或在连续对话窗格内插话时会被本地声纹门禁过滤，不会触发 AI 对话或写入对话记忆（未录入任何声纹前行为保持兼容放行）。

- **双阶段本地门禁 + 尾音裁剪**：
  1. **阶段 1 唤醒预检（1.8s 环形缓冲）**：触发 `KWS` 唤醒词时，直接提取最近 1.8s 唤醒语音声纹（`3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`）；非已录入家庭成员的电视声直接拒绝，音箱不响“在”、不闪灯。
  2. **阶段 2 整句校验与电视尾音裁剪**：若用户刚说完“明天天气怎么样”紧接着电视接话导致 VAD 没能及时停下，系统会在捕获过程中检测连续非成员语音并提前收口，在送交 ASR 前使用滑动窗口将电视尾音截除；连续对话/电视遥控等待窗内听到电视声则就地重武装剩余等待时长。
  3. **关闭未认证日志旁路**：启用声纹门禁时，会自动跳过 `/tmp/mico_aivs_lab/instruction.log` 轮询，防止绕过声纹校验。
- **直接语音管理（支持多人）**：
  - 录入/重录个人声纹：**“你好星期五，录入我的声纹”**、**“重新录入我的声纹”**、**“补充我的声纹”**
  - 为家人录入声纹：**“你好星期五，帮老婆录入声纹”**、**“帮小明录入声纹”**（音箱会引导采集 3 句样本，可随时说“取消”或“算了”退出）
  - 身份查询与管理：**“我是谁”**、**“查看声纹列表”**、**“删除小明的声纹”**、**“暂停声纹识别”** / **“开启声纹识别”** / **“清空所有声纹”**（涉及主人声纹删除或清空全部仅限主人或 CLI 操作）
- **CLI 管理（推荐终端辅助查看状态或批量管理）**：
  ```bash
  # 检查本地声纹模型与已录入人员列表
  friday voice status

  # 预先下载本地声纹模型（~27MB，首次语音录入也会自动下载）
  friday voice model

  # 通过正在运行的小爱音箱交互式采集并录入主人或家人声纹
  friday voice enroll 主人 --role owner
  friday voice enroll 老婆 --role member

  # 为已有成员追加更多句样本以提高抗干扰能力
  friday voice enroll 主人 --append

  # 调整识别阈值（默认 0.45，范围 0.10–0.95）或启用/暂停门禁
  friday voice config --threshold 0.48
  friday voice disable
  friday voice enable

  # 重命名、修改角色、删除或清空
  friday voice rename 成员2 爸爸
  friday voice role 老婆 member
  friday voice remove 小明
  friday voice clear
  ```
- **频道 URL 覆盖参数**（可选，拼在 XiaoAI `--api-base` 查询串后）：
  - `speakerVerify=0`：单独关闭该音箱频道的声纹门禁（忽略全局开启状态）；
  - `speakerThreshold=0.50`：为特定房间音箱单独指定匹配阈值。
