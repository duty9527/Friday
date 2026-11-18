#!/bin/sh
# F.R.I.D.A.Y. 小爱音箱局域网桥接脚本（兼容 POSIX /bin/sh，适用于已 Root 的 BE6500 Pro / OpenWrt 路由器或音箱本机）
# 功能：
# 1. 监听本机或远端小爱音箱的 /tmp/mico_aivs_lab/instruction.log 最终识别文本
# 2. 命中触发词后立即通过 ubus 暂停小爱原生抢答
# 3. 若配置 MAC_PING_HOST 且检测到宿主机休眠，发送 WOL 魔术包唤醒并由音箱播报等待提示
# 4. 将语音指令 POST 到 F.R.I.D.A.Y. Webhook（携带 x-xiaoai-secret 请求头）

set -euf

FRIDAY_WEBHOOK_URL="${FRIDAY_WEBHOOK_URL:-}"
FRIDAY_SECRET="${FRIDAY_SECRET:-}"
SPEAKER_HOST="${FRIDAY_SPEAKER_HOST:-${SPEAKER_HOST:-}}"
SPEAKER_PORT="${FRIDAY_SPEAKER_PORT:-${SPEAKER_PORT:-}}"
SPEAKER_ID="${FRIDAY_SPEAKER_ID:-${SPEAKER_ID:-}}"
MAC_WOL_MAC="${FRIDAY_WOL_MAC:-${MAC_WOL_MAC:-}}"
MAC_WOL_IFACE="${FRIDAY_WOL_IFACE:-${MAC_WOL_IFACE:-br-lan}}"
MAC_PING_HOST="${FRIDAY_HOST_PING:-${MAC_PING_HOST:-}}"
TRIGGER_PREFIX="${FRIDAY_TRIGGER_PREFIX:-${TRIGGER_PREFIX:-}}"
POLL_INTERVAL="${FRIDAY_POLL_INTERVAL:-${POLL_INTERVAL:-1}}"
LOG_FILE="${FRIDAY_XIAOAI_LOG_FILE:-${XIAOAI_LOG_FILE:-/tmp/mico_aivs_lab/instruction.log}}"

usage() {
  cat <<'EOF'
用法: xiaoai-router-bridge.sh [选项]

环境变量或命令行参数:
  --webhook-url URL     F.R.I.D.A.Y. Webhook 回调地址 (FRIDAY_WEBHOOK_URL)
  --secret SECRET       Webhook 签名密钥 (FRIDAY_SECRET)
  --speaker-host HOST   音箱 SSH 地址，如 root@192.0.2.101；留空表示在音箱本机运行 (FRIDAY_SPEAKER_HOST / SPEAKER_HOST)
  --speaker-port PORT   音箱 SSH 端口（可选） (FRIDAY_SPEAKER_PORT / SPEAKER_PORT)
  --speaker-id ID       上报给 Friday 的设备标识，默认取 SPEAKER_HOST 或 default (FRIDAY_SPEAKER_ID / SPEAKER_ID)
  --mac-wol MAC         宿主机网卡 MAC 地址，用于 Wake-on-LAN (FRIDAY_WOL_MAC / MAC_WOL_MAC)
  --wol-iface IFACE     ether-wake 使用的网口，默认 br-lan (FRIDAY_WOL_IFACE / MAC_WOL_IFACE)
  --mac-ping HOST       宿主机局域网 IP，用于检测休眠并触发 WOL (FRIDAY_HOST_PING / MAC_PING_HOST)
  --prefix PREFIX       逗号分隔的触发前缀，如 "星期五,Friday"；留空由服务端判定 (FRIDAY_TRIGGER_PREFIX / TRIGGER_PREFIX)
  --interval SEC        轮询日志间隔秒数，默认 1 (FRIDAY_POLL_INTERVAL / POLL_INTERVAL)
  -h, --help            显示此帮助
EOF
}

require_value() {
  if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
    echo "[xiaoai-bridge] 错误: 参数 $1 缺少值" >&2
    exit 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --webhook-url) require_value "$@"; FRIDAY_WEBHOOK_URL="$2"; shift 2 ;;
    --secret) require_value "$@"; FRIDAY_SECRET="$2"; shift 2 ;;
    --speaker-host) require_value "$@"; SPEAKER_HOST="$2"; shift 2 ;;
    --speaker-port) require_value "$@"; SPEAKER_PORT="$2"; shift 2 ;;
    --speaker-id) require_value "$@"; SPEAKER_ID="$2"; shift 2 ;;
    --mac-wol) require_value "$@"; MAC_WOL_MAC="$2"; shift 2 ;;
    --wol-iface) require_value "$@"; MAC_WOL_IFACE="$2"; shift 2 ;;
    --mac-ping) require_value "$@"; MAC_PING_HOST="$2"; shift 2 ;;
    --prefix) require_value "$@"; TRIGGER_PREFIX="$2"; shift 2 ;;
    --interval) require_value "$@"; POLL_INTERVAL="$2"; shift 2 ;;
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

if [ -n "$SPEAKER_HOST" ]; then
  case "$SPEAKER_HOST" in
    -*)
      echo "[xiaoai-bridge] 错误: 非法的 SPEAKER_HOST（不可由 '-' 开头）" >&2
      exit 2
      ;;
  esac
fi

if [ -n "$SPEAKER_PORT" ]; then
  case "$SPEAKER_PORT" in
    *[!0-9]*)
      echo "[xiaoai-bridge] 错误: SPEAKER_PORT 必须为纯数字端口" >&2
      exit 2
      ;;
  esac
fi

run_speaker_cmd() {
  cmd="$1"
  if [ -z "$SPEAKER_HOST" ]; then
    sh -c "$cmd"
  elif [ -n "$SPEAKER_PORT" ]; then
    ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa -p "$SPEAKER_PORT" -- "$SPEAKER_HOST" "$cmd"
  else
    ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa -- "$SPEAKER_HOST" "$cmd"
  fi
}

pause_native_speaker() {
  run_speaker_cmd 'ubus call mediaplayer player_play_operation "{\"action\":\"pause\"}" >/dev/null 2>&1 || mphelper pause >/dev/null 2>&1 || true' >/dev/null 2>&1 || true
}

speak_on_speaker() {
  tts_text="$1"
  escaped_text=$(printf '%s' "$tts_text" | tr -d '\000-\037\177' | sed 's/\\/\\\\/g; s/"/\\"/g')
  payload="{\"text\":\"${escaped_text}\",\"save\":0}"
  escaped_payload=$(printf '%s' "$payload" | sed "s/'/'\\\\''/g")
  escaped_plain=$(printf '%s' "$tts_text" | tr -d '\000-\037\177' | sed "s/'/'\\\\''/g")
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

escape_single_quotes() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

json_escape() {
  printf '%s' "$1" | tr -d '\000-\037\177' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

line_checksum() {
  printf '%s' "$1" | cksum | awk '{print $1 "-" $2}'
}

post_to_friday() {
  query_text="$1"
  msg_id="${2:-}"
  escaped_query=$(json_escape "$query_text")
  escaped_id=$(json_escape "$SPEAKER_ID")
  escaped_prefix=$(json_escape "$TRIGGER_PREFIX")
  escaped_msg_id=$(json_escape "$msg_id")
  if [ -n "$escaped_msg_id" ]; then
    json_body="{\"text\":\"${escaped_query}\",\"deviceId\":\"${escaped_id}\",\"prefix\":\"${escaped_prefix}\",\"msgId\":\"${escaped_msg_id}\"}"
  else
    json_body="{\"text\":\"${escaped_query}\",\"deviceId\":\"${escaped_id}\",\"prefix\":\"${escaped_prefix}\"}"
  fi

  if command -v curl >/dev/null 2>&1; then
    if [ -n "$FRIDAY_SECRET" ]; then
      escaped_curl_secret=$(json_escape "$FRIDAY_SECRET")
      printf 'header = "x-xiaoai-secret: %s"\n' "$escaped_curl_secret" | curl -sS -m 10 -K - -X POST "$FRIDAY_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "$json_body" >/dev/null
    else
      curl -sS -m 10 -X POST "$FRIDAY_WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "$json_body" >/dev/null
    fi
    return $?
  fi

  if command -v python3 >/dev/null 2>&1; then
    FRIDAY_WEBHOOK_SECRET="$FRIDAY_SECRET" python3 - "$FRIDAY_WEBHOOK_URL" "$json_body" <<'PY'
import os, sys, urllib.request
url, body = sys.argv[1], sys.argv[2].encode('utf-8')
secret = os.environ.get('FRIDAY_WEBHOOK_SECRET', '')
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

read_log_meta_and_delta() {
  offset="${1:-0}"
  last_inode="${2:-}"
  skip_read="${3:-0}"
  case "$offset" in ''|*[!0-9]*) offset=0 ;; esac
  case "$last_inode" in *[!0-9A-Za-z_-]*) last_inode="" ;; esac
  q_log=$(escape_single_quotes "$LOG_FILE")
  remote_cmd="F='${q_log}'; [ -f \"\$F\" ] && [ ! -L \"\$F\" ] || exit 0; ino=\$(stat -c '%i' \"\$F\" 2>/dev/null || ls -i \"\$F\" 2>/dev/null | awk '{print \$1}' || true); size=\$(wc -c < \"\$F\" 2>/dev/null | tr -d ' \t\r\n'); [ -n \"\$size\" ] || exit 0; printf '__META__ %s %s\\n' \"\${ino:-0}\" \"\$size\"; [ '${skip_read}' = '1' ] && exit 0; start_off=${offset}; if [ -n '${last_inode}' ] && [ -n \"\$ino\" ] && [ \"\$ino\" != '${last_inode}' ]; then start_off=0; elif [ \"\$size\" -lt \"\$start_off\" ]; then start_off=0; fi; if [ \"\$size\" -gt \"\$start_off\" ]; then tail -c +\$((start_off + 1)) \"\$F\" 2>/dev/null || dd if=\"\$F\" bs=1 skip=\"\$start_off\" 2>/dev/null || true; fi"
  run_speaker_cmd "$remote_cmd" 2>/dev/null || true
}

LOG_INODE=""
LOG_OFFSET=0

init_log_cursor() {
  meta_out=$(read_log_meta_and_delta 0 "" 1)
  if [ -n "$meta_out" ]; then
    first_line=$(printf '%s\n' "$meta_out" | sed -n '1p')
    case "$first_line" in
      __META__\ *)
        meta_rest="${first_line#__META__ }"
        LOG_INODE="${meta_rest%% *}"
        LOG_OFFSET="${meta_rest#* }"
        case "$LOG_OFFSET" in ''|*[!0-9]*) LOG_OFFSET=0 ;; esac
        ;;
    esac
  fi
}

poll_log_once() {
  snapshot=$(read_log_meta_and_delta "$LOG_OFFSET" "$LOG_INODE" 0)
  [ -n "$snapshot" ] || return 0
  meta_line=$(printf '%s\n' "$snapshot" | sed -n '1p')
  case "$meta_line" in
    __META__\ *)
      meta_rest="${meta_line#__META__ }"
      cur_inode="${meta_rest%% *}"
      cur_size="${meta_rest#* }"
      case "$cur_size" in ''|*[!0-9]*) return 0 ;; esac
      ;;
    *)
      return 0
      ;;
  esac

  batch_offset="$LOG_OFFSET"
  if [ -n "$LOG_INODE" ] && [ "$cur_inode" != "$LOG_INODE" ]; then
    batch_offset=0
  elif [ "$cur_size" -lt "$LOG_OFFSET" ]; then
    batch_offset=0
  fi

  LOG_INODE="$cur_inode"
  LOG_OFFSET="$cur_size"

  new_lines=$(printf '%s\n' "$snapshot" | sed '1d')
  [ -n "$new_lines" ] || return 0

  line_idx=0
  old_ifs="$IFS"
  IFS='
'
  for line in $new_lines; do
    [ -n "$line" ] || continue
    line_idx=$((line_idx + 1))
    if query=$(extract_query_from_line "$line"); then
      if matches_prefix "$query"; then
        msg_hash=$(line_checksum "$line")
        msg_id="${SPEAKER_ID}:${cur_inode}:${batch_offset}:${line_idx}:${msg_hash}"
        echo "[xiaoai-bridge] 捕获语音指令: ${query}"
        pause_native_speaker
        ensure_mac_awake
        if ! post_to_friday "$query" "$msg_id"; then
          echo "[xiaoai-bridge] 投递 Friday Webhook 失败" >&2
        fi
      fi
    fi
  done
  IFS="$old_ifs"
}

if [ "${FRIDAY_BRIDGE_LIB_ONLY:-0}" != "1" ]; then
  echo "[xiaoai-bridge] 已启动监听 (${SPEAKER_ID}) -> ${FRIDAY_WEBHOOK_URL}"
  init_log_cursor
  while true; do
    poll_log_once
    sleep "$POLL_INTERVAL"
  done
fi
