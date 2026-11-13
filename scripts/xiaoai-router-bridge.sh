#!/bin/sh
# F.R.I.D.A.Y. 小爱音箱局域网桥接脚本（兼容 POSIX /bin/sh，适用于已 Root 的 BE6500 Pro / OpenWrt 路由器或音箱本机）
# 功能：
# 1. 监听本机或远端小爱音箱的 /tmp/mico_aivs_lab/instruction.log 最终识别文本
# 2. 命中触发词后立即通过 ubus 暂停小爱原生抢答
# 3. 若配置 MAC_PING_HOST 且检测到 Mac 主机休眠，发送 WOL 魔术包唤醒并由音箱播报等待提示
# 4. 将语音指令 POST 到 F.R.I.D.A.Y. Webhook（携带 x-xiaoai-secret 请求头）

set -eu

FRIDAY_WEBHOOK_URL="${FRIDAY_WEBHOOK_URL:-}"
FRIDAY_SECRET="${FRIDAY_SECRET:-}"
SPEAKER_HOST="${SPEAKER_HOST:-}"
SPEAKER_PORT="${SPEAKER_PORT:-}"
SPEAKER_ID="${SPEAKER_ID:-}"
MAC_WOL_MAC="${MAC_WOL_MAC:-}"
MAC_WOL_IFACE="${MAC_WOL_IFACE:-br-lan}"
MAC_PING_HOST="${MAC_PING_HOST:-}"
TRIGGER_PREFIX="${TRIGGER_PREFIX:-}"
POLL_INTERVAL="${POLL_INTERVAL:-1}"
LOG_FILE="${XIAOAI_LOG_FILE:-/tmp/mico_aivs_lab/instruction.log}"

usage() {
  cat <<'EOF'
用法: xiaoai-router-bridge.sh [选项]

环境变量或命令行参数:
  --webhook-url URL     F.R.I.D.A.Y. Webhook 回调地址 (FRIDAY_WEBHOOK_URL)
  --secret SECRET       Webhook 签名密钥 (FRIDAY_SECRET)
  --speaker-host HOST   音箱 SSH 地址，如 root@192.168.31.101；留空表示在音箱本机运行 (SPEAKER_HOST)
  --speaker-port PORT   音箱 SSH 端口（可选） (SPEAKER_PORT)
  --speaker-id ID       上报给 Friday 的设备标识，默认取 SPEAKER_HOST 或 default (SPEAKER_ID)
  --mac-wol MAC         Mac 网卡 MAC 地址，用于 Wake-on-LAN (MAC_WOL_MAC)
  --wol-iface IFACE     ether-wake 使用的网口，默认 br-lan (MAC_WOL_IFACE)
  --mac-ping HOST       Mac 主机局域网 IP，用于检测休眠并触发 WOL (MAC_PING_HOST)
  --prefix PREFIX       逗号分隔的触发前缀，如 "星期五,Friday"；留空由服务端判定 (TRIGGER_PREFIX)
  --interval SEC        轮询日志间隔秒数，默认 1 (POLL_INTERVAL)
  -h, --help            显示此帮助
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --webhook-url) FRIDAY_WEBHOOK_URL="$2"; shift 2 ;;
    --secret) FRIDAY_SECRET="$2"; shift 2 ;;
    --speaker-host) SPEAKER_HOST="$2"; shift 2 ;;
    --speaker-port) SPEAKER_PORT="$2"; shift 2 ;;
    --speaker-id) SPEAKER_ID="$2"; shift 2 ;;
    --mac-wol) MAC_WOL_MAC="$2"; shift 2 ;;
    --wol-iface) MAC_WOL_IFACE="$2"; shift 2 ;;
    --mac-ping) MAC_PING_HOST="$2"; shift 2 ;;
    --prefix) TRIGGER_PREFIX="$2"; shift 2 ;;
    --interval) POLL_INTERVAL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[xiaoai-bridge] 未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$FRIDAY_WEBHOOK_URL" ]; then
  echo "[xiaoai-bridge] 错误: 请设置 FRIDAY_WEBHOOK_URL 或传入 --webhook-url" >&2
  exit 1
fi

if [ -z "$SPEAKER_ID" ]; then
  if [ -n "$SPEAKER_HOST" ]; then
    SPEAKER_ID="$SPEAKER_HOST"
  else
    SPEAKER_ID="default"
  fi
fi

run_speaker_cmd() {
  cmd="$1"
  if [ -z "$SPEAKER_HOST" ]; then
    sh -c "$cmd"
  elif [ -n "$SPEAKER_PORT" ]; then
    ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa -p "$SPEAKER_PORT" "$SPEAKER_HOST" "$cmd"
  else
    ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa "$SPEAKER_HOST" "$cmd"
  fi
}

pause_native_speaker() {
  run_speaker_cmd 'ubus call mediaplayer player_play_operation "{\"action\":\"pause\"}" >/dev/null 2>&1 || mphelper pause >/dev/null 2>&1 || true' >/dev/null 2>&1 || true
}

speak_on_speaker() {
  tts_text="$1"
  escaped_text=$(printf '%s' "$tts_text" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g')
  payload="{\"text\":\"${escaped_text}\",\"save\":0}"
  escaped_payload=$(printf '%s' "$payload" | sed "s/'/'\\\\''/g")
  escaped_plain=$(printf '%s' "$tts_text" | sed "s/'/'\\\\''/g")
  run_speaker_cmd "ubus call mibrain text_to_speech '${escaped_payload}' >/dev/null 2>&1 || /usr/sbin/tts_play.sh '${escaped_plain}' >/dev/null 2>&1 || true" >/dev/null 2>&1 || true
}

send_wol_packet() {
  mac="$1"
  if [ -z "$mac" ]; then
    return 1
  fi
  if command -v ether-wake >/dev/null 2>&1; then
    ether-wake -i "$MAC_WOL_IFACE" "$mac" >/dev/null 2>&1 || ether-wake "$mac" >/dev/null 2>&1 || true
    return 0
  fi
  if command -v wakeonlan >/dev/null 2>&1; then
    wakeonlan "$mac" >/dev/null 2>&1 || true
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$mac" <<'PY' >/dev/null 2>&1 || true
import socket, sys
mac_hex = sys.argv[1].replace(':', '').replace('-', '')
if len(mac_hex) == 12:
    pkt = b'\xff' * 6 + bytes.fromhex(mac_hex) * 16
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.sendto(pkt, ('255.255.255.255', 9))
    s.close()
PY
    return 0
  fi
  if command -v nc >/dev/null 2>&1; then
    clean_mac=$(printf '%s' "$mac" | tr -d ':-' | tr 'a-f' 'A-F')
    if [ "${#clean_mac}" -eq 12 ]; then
      b1=$(printf '%s' "$clean_mac" | cut -c1-2)
      b2=$(printf '%s' "$clean_mac" | cut -c3-4)
      b3=$(printf '%s' "$clean_mac" | cut -c5-6)
      b4=$(printf '%s' "$clean_mac" | cut -c7-8)
      b5=$(printf '%s' "$clean_mac" | cut -c9-10)
      b6=$(printf '%s' "$clean_mac" | cut -c11-12)
      seq_bytes="\\x${b1}\\x${b2}\\x${b3}\\x${b4}\\x${b5}\\x${b6}"
      magic='\\xff\\xff\\xff\\xff\\xff\\xff'
      i=0
      while [ "$i" -lt 16 ]; do
        magic="${magic}${seq_bytes}"
        i=$((i + 1))
      done
      # shellcheck disable=SC2059
      printf "$magic" | nc -u -w 1 255.255.255.255 9 >/dev/null 2>&1 || true
      return 0
    fi
  fi
  return 1
}

ensure_mac_awake() {
  if [ -z "$MAC_PING_HOST" ]; then
    return 0
  fi
  if ping -c 1 -W 1 "$MAC_PING_HOST" >/dev/null 2>&1; then
    return 0
  fi
  echo "[xiaoai-bridge] 检测到主机 ${MAC_PING_HOST} 不可达，尝试唤醒..."
  if [ -n "$MAC_WOL_MAC" ]; then
    send_wol_packet "$MAC_WOL_MAC" || true
  fi
  speak_on_speaker "正在为您唤醒星期五主机，请稍候"
  wait_sec=0
  while [ "$wait_sec" -lt 15 ]; do
    sleep 1
    wait_sec=$((wait_sec + 1))
    if ping -c 1 -W 1 "$MAC_PING_HOST" >/dev/null 2>&1; then
      echo "[xiaoai-bridge] 主机 ${MAC_PING_HOST} 已唤醒"
      return 0
    fi
  done
  echo "[xiaoai-bridge] 等待主机唤醒超时，仍尝试投递请求" >&2
  return 0
}

extract_query_from_line() {
  line="$1"
  if [ -z "$line" ]; then
    return 1
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$line" <<'PY'
import json, sys
raw = sys.argv[1].strip()
if not raw:
    sys.exit(1)
try:
    obj = json.loads(raw)
except Exception:
    print(raw)
    sys.exit(0)
if not isinstance(obj, dict):
    sys.exit(1)
header = obj.get('header') if isinstance(obj.get('header'), dict) else {}
payload = obj.get('payload') if isinstance(obj.get('payload'), dict) else {}
ns = header.get('namespace')
name = header.get('name')
if ns == 'SpeechRecognizer':
    if name != 'RecognizeResult' or payload.get('is_final') is False:
        sys.exit(1)
    results = payload.get('results')
    if isinstance(results, list) and results and isinstance(results[0], dict):
        txt = str(results[0].get('text') or '').strip()
        if txt:
            print(txt)
            sys.exit(0)
    sys.exit(1)
for key in ('query', 'text', 'asr'):
    val = obj.get(key)
    if isinstance(val, str) and val.strip():
        print(val.strip())
        sys.exit(0)
sys.exit(1)
PY
    return $?
  fi
  case "$line" in
    \{*)
      if command -v jsonfilter >/dev/null 2>&1; then
        ns=$(printf '%s' "$line" | jsonfilter -e '@.header.namespace' 2>/dev/null || true)
        name=$(printf '%s' "$line" | jsonfilter -e '@.header.name' 2>/dev/null || true)
        if [ "$ns" = "SpeechRecognizer" ]; then
          [ "$name" = "RecognizeResult" ] || return 1
          is_final=$(printf '%s' "$line" | jsonfilter -e '@.payload.is_final' 2>/dev/null || true)
          [ "$is_final" != "false" ] || return 1
          txt=$(printf '%s' "$line" | jsonfilter -e '@.payload.results[0].text' 2>/dev/null || true)
          [ -n "$txt" ] || return 1
          printf '%s\n' "$txt"
          return 0
        fi
        txt=$(printf '%s' "$line" | jsonfilter -e '@.query' 2>/dev/null || printf '%s' "$line" | jsonfilter -e '@.text' 2>/dev/null || printf '%s' "$line" | jsonfilter -e '@.asr' 2>/dev/null || true)
        [ -n "$txt" ] || return 1
        printf '%s\n' "$txt"
        return 0
      fi
      # 轻量 sed 兜底提取 AIVS text 字段
      case "$line" in
        *'"SpeechRecognizer"'*)
          case "$line" in
            *'"RecognizeResult"'*) ;;
            *) return 1 ;;
          esac
          case "$line" in
            *'"is_final":false'*|*'"is_final": false'*) return 1 ;;
          esac
          ;;
      esac
      txt=$(printf '%s' "$line" | sed -n 's/.*"text"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
      [ -n "$txt" ] || return 1
      printf '%s\n' "$txt"
      return 0
      ;;
    *)
      printf '%s\n' "$line"
      return 0
      ;;
  esac
}

matches_prefix() {
  raw_query="$1"
  cleaned=$(printf '%s' "$raw_query" | sed 's/^[[:space:]]*小爱同学[，,。！![:space:]]*//')
  if [ -z "$cleaned" ]; then
    return 1
  fi
  if [ -z "$TRIGGER_PREFIX" ]; then
    return 0
  fi
  lower_cleaned=$(printf '%s' "$cleaned" | tr '[:upper:]' '[:lower:]')
  old_ifs="$IFS"
  IFS=','
  for p in $TRIGGER_PREFIX; do
    p_trim=$(printf '%s' "$p" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$p_trim" ] || continue
    lower_p=$(printf '%s' "$p_trim" | tr '[:upper:]' '[:lower:]')
    case "$lower_cleaned" in
      "$lower_p"*)
        IFS="$old_ifs"
        return 0
        ;;
    esac
  done
  IFS="$old_ifs"
  return 1
}

post_to_friday() {
  query_text="$1"
  escaped_query=$(printf '%s' "$query_text" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g')
  escaped_id=$(printf '%s' "$SPEAKER_ID" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g')
  escaped_prefix=$(printf '%s' "$TRIGGER_PREFIX" | tr -d '\r\n' | sed 's/\\/\\\\/g; s/"/\\"/g')
  json_body="{\"text\":\"${escaped_query}\",\"deviceId\":\"${escaped_id}\",\"prefix\":\"${escaped_prefix}\"}"

  if command -v curl >/dev/null 2>&1; then
    if [ -n "$FRIDAY_SECRET" ]; then
      curl -sS -m 10 -X POST "$FRIDAY_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -H "x-xiaoai-secret: ${FRIDAY_SECRET}" \
        -d "$json_body" >/dev/null
    else
      curl -sS -m 10 -X POST "$FRIDAY_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "$json_body" >/dev/null
    fi
    return $?
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$FRIDAY_WEBHOOK_URL" "$FRIDAY_SECRET" "$json_body" <<'PY'
import sys, urllib.request
url, secret, body = sys.argv[1], sys.argv[2], sys.argv[3].encode('utf-8')
headers = {'Content-Type': 'application/json'}
if secret:
    headers['x-xiaoai-secret'] = secret
req = urllib.request.Request(url, data=body, headers=headers, method='POST')
with urllib.request.urlopen(req, timeout=10) as resp:
    if resp.status >= 400:
        sys.exit(1)
PY
    return $?
  fi

  if command -v wget >/dev/null 2>&1; then
    if [ -n "$FRIDAY_SECRET" ]; then
      wget -q -O /dev/null --header="Content-Type: application/json" --header="x-xiaoai-secret: ${FRIDAY_SECRET}" --post-data="$json_body" "$FRIDAY_WEBHOOK_URL"
    else
      wget -q -O /dev/null --header="Content-Type: application/json" --post-data="$json_body" "$FRIDAY_WEBHOOK_URL"
    fi
    return $?
  fi

  echo "[xiaoai-bridge] 错误: 缺少 curl / python3 / wget，无法发送 HTTP 请求" >&2
  return 1
}

read_log_tail() {
  run_speaker_cmd "tail -n 20 '${LOG_FILE}' 2>/dev/null || true" 2>/dev/null || true
}

echo "[xiaoai-bridge] 已启动监听 (${SPEAKER_ID}) -> ${FRIDAY_WEBHOOK_URL}"
last_seen_line=""
baseline_snapshot=$(read_log_tail)
if [ -n "$baseline_snapshot" ]; then
  last_seen_line=$(printf '%s\n' "$baseline_snapshot" | awk 'NF{line=$0} END{print line}')
fi

while true; do
  snapshot=$(read_log_tail)
  if [ -n "$snapshot" ]; then
    new_lines=""
    if [ -z "$last_seen_line" ]; then
      new_lines="$snapshot"
    else
      found_cursor=0
      tmp_lines=""
      old_ifs="$IFS"
      IFS='
'
      for cur_line in $snapshot; do
        if [ "$found_cursor" -eq 1 ]; then
          if [ -n "$tmp_lines" ]; then
            tmp_lines="${tmp_lines}
${cur_line}"
          else
            tmp_lines="$cur_line"
          fi
        elif [ "$cur_line" = "$last_seen_line" ]; then
          found_cursor=1
        fi
      done
      IFS="$old_ifs"
      if [ "$found_cursor" -eq 1 ]; then
        new_lines="$tmp_lines"
      else
        # 日志已轮转或超出 tail 窗口，取最后一条并更新基线，避免重放旧记录
        new_lines=$(printf '%s\n' "$snapshot" | awk 'NF{line=$0} END{print line}')
      fi
    fi

    if [ -n "$new_lines" ]; then
      old_ifs="$IFS"
      IFS='
'
      for line in $new_lines; do
        [ -n "$line" ] || continue
        last_seen_line="$line"
        if query=$(extract_query_from_line "$line"); then
          if matches_prefix "$query"; then
            echo "[xiaoai-bridge] 捕获语音指令: ${query}"
            pause_native_speaker
            ensure_mac_awake
            if ! post_to_friday "$query"; then
              echo "[xiaoai-bridge] 投递 Friday Webhook 失败" >&2
            fi
          fi
        fi
      done
      IFS="$old_ifs"
    fi
  fi
  sleep "$POLL_INTERVAL"
done
