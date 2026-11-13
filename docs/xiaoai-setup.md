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
