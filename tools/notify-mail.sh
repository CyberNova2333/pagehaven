#!/usr/bin/env bash
# 标准邮件通知：把一次构建 / 部署的结果发到全域邮件转发端点。
#
# 这套是**组织内各仓库共用的一份标准脚本**（同名、同内容、同变量）：
#   客户端仓 / 门面站点仓 / 在线配置仓 / 内容补丁仓 / 离线资源包仓
# 改一处就要同步其余几处；脚本头这段「共用」说明也一并保留。
#
# 用法（全部走环境变量）：
#   TITLE="🔴 ..." MSG="..." NOTIFY_URL=... NOTIFY_TOKEN=... NOTIFY_TO=... \
#     NOTIFY_FROM=... bash tools/notify-mail.sh
#
# 环境变量：
#   NOTIFY_URL        通知端点。**标准端点（以 /v1/send 结尾）**，地址不带 query 参数；
#                     取值见密钥仓库里对应项目的 notify.yml
#   NOTIFY_TOKEN      Bearer 令牌（仓库机密，与端点上的 AUTH_TOKENS 一致）
#   NOTIFY_TO         收件人，逗号/分号/空格分隔多个，逐人各发一封
#   NOTIFY_FROM       发件地址——**必需**：服务端要求它是合法地址，域要在端点的允许发件域里，
#                     地址本身还要在平台侧验证过；给空串等于白发一次请求
#   NOTIFY_FROM_NAME  发件人显示名（可空；空则整个不发这个字段）
#   TITLE / MSG       邮件主题 / 正文
#
# 一次请求只带一个收件人：逐人各自报成败，也省掉服务端「同一请求内不许重复收件人」那条。
#
# 报文是**标准形状**（不是面板那套 title/msg/type）：from 是对象（有显示名才带 name）、
# to 是纯地址、subject / text 直接给。各仓库、各语言写出来的调用方因此长得一样，
# 服务端也只有一套字段规则要维护。
#
# 解释器：报文体要正确转义（TITLE/MSG 里有换行、引号），所以需要一个能 json 编码的小工具。
# **按 python3 → python → py -3 → node 逐个真跑探测**（与仓库钩子同一套路数：只认真能跑的，
# 不看命令在不在）。各仓库的 CI 镜像不一样——alpine 系没有 python3，所以 node 兜底是必需的。
# 一个都找不到时**明说并以非零退出**，不生成空报文：空报文只会变成一行 "must be valid JSON" 的
# 400，那种提示指向的是错误方向。
#
# 原则：**通知没发出去就必须显式失败**。变量没配齐、找不到解释器、报文没能生成、网络断了、
# 服务端 4xx/5xx——一律打 ::error:: 并以非零退出码结束，让「红灯邮件」这一步在流水线上变红。
#
#   本脚本跑在 .cnb.yml 的 failStages 里，**只有构建已经失败时才会执行**；CNB 的退出码语义是
#   「0=成功、78=成功但中断、其它=任务失败并中断当前流水线」。所以它变红不会掩盖原本的失败
#   原因（失败阶段与原因由 CNB_BUILD_FAILED_* 传递，不看这一步的结论），只会让「通知实际没
#   送达」这件事不再被静默吞掉。
#
#   ⚠ 旧版本一律 exit 0（失败只留一行 warning），代价是上游 502 时这一步照样全绿：通知没发
#   出去，而构建页面上看不出任何异常。**不要改回那个行为。**
#
# 证书校验保持开启（curl 默认）。
set -uo pipefail

if [ -z "${NOTIFY_URL:-}" ] || [ -z "${NOTIFY_TOKEN:-}" ] \
   || [ -z "${NOTIFY_TO:-}" ] || [ -z "${NOTIFY_FROM:-}" ]; then
  echo "::error::红灯邮件未发出：NOTIFY_URL / NOTIFY_TOKEN / NOTIFY_TO / NOTIFY_FROM 未配齐"
  exit 1
fi

# 注意这里**写字节**而不是 print()：Windows 上 print 走控制台编码（cp936/GBK），
# 标题里的 emoji 这种字符编不进去会直接抛错（CI 是 Linux/UTF-8，碰不到；本机跑就会碰到）。
PY_BODY='
import json, os, sys

SUBJECT_LIMIT = 256        # 与服务端的 subject 上限一致
TEXT_LIMIT = int(os.environ.get("NOTIFY_MAX_TEXT_BYTES") or 16384)


def clamp(value, limit, note):
    """按 UTF-8 **字节**截断，且不切碎多字节字符。

    截断必须做在共享脚本里：不做的话一封长邮件会被服务端判 400（subject 超 256 字节），
    而随手用 head -c 去截又会切到半个汉字、变成非法 UTF-8——同样是 400。
    """
    raw = value.encode("utf-8")
    if len(raw) <= limit:
        return value
    # 备注是**截断之后拼上去的**，所以预算要从上限里先扣掉它——
    # 否则"截到 256 字节再加三个点"的结果是 259 字节，服务端照样判超限
    budget = limit - len(note.encode("utf-8"))
    return raw[:max(budget, 0)].decode("utf-8", "ignore") + note


sender = {"email": os.environ["NOTIFY_FROM"]}
name = os.environ.get("NOTIFY_FROM_NAME", "")
if name:
    sender["name"] = name          # 空的就整个不发这个键：服务端把空串当非法值

body = json.dumps({
    "from": sender,
    "to": os.environ["TO"],
    "subject": clamp(os.environ.get("TITLE", ""), SUBJECT_LIMIT, "…"),
    "text": clamp(os.environ.get("MSG", ""), TEXT_LIMIT, "\n\n（正文过长已截断，完整内容见构建日志）"),
}, ensure_ascii=False)
sys.stdout.buffer.write(body.encode("utf-8"))
'

JS_BODY='
const e = process.env;
const SUBJECT_LIMIT = 256;
const TEXT_LIMIT = Number(e.NOTIFY_MAX_TEXT_BYTES || 16384);

// 与 python 那份同样的按字节截断（两份行为必须一致，否则换个解释器结果就不同）
const clamp = (value, limit, note) => {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= limit) return value;
  // 备注是截断之后拼上去的，预算要先扣掉它（见 python 那份的同款注释）
  const budget = Math.max(limit - Buffer.byteLength(note, "utf8"), 0);
  return new TextDecoder("utf-8").decode(buf.subarray(0, budget)) + note;
};

const sender = { email: e.NOTIFY_FROM };
if (e.NOTIFY_FROM_NAME) sender.name = e.NOTIFY_FROM_NAME;
process.stdout.write(JSON.stringify({
  from: sender,
  to: e.TO,
  subject: clamp(e.TITLE ?? "", SUBJECT_LIMIT, "…"),
  text: clamp(e.MSG ?? "", TEXT_LIMIT, "\n\n（正文过长已截断，完整内容见构建日志）"),
}));
'

BODY_TOOL=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import json' >/dev/null 2>&1; then
    BODY_TOOL="$candidate"; break
  fi
done
if [ -z "$BODY_TOOL" ] && command -v py >/dev/null 2>&1 && py -3 -c 'import json' >/dev/null 2>&1; then
  BODY_TOOL="py -3"
fi
if [ -z "$BODY_TOOL" ] && command -v node >/dev/null 2>&1; then
  BODY_TOOL="node"
fi
if [ -z "$BODY_TOOL" ]; then
  echo "::error::红灯邮件未发出：镜像里没有能用的 python3 / node（报文体无法正确转义）"
  exit 1
fi

BODY_FILE=$(mktemp); RESP_FILE=$(mktemp); ERR_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE" "$RESP_FILE" "$ERR_FILE"' EXIT

# 逐人报成败，最后按「有没有人没收到」决定这一步的结论：发出去几封不算成功，
# 只要有一封没送到就是失败——收件人是人，漏掉谁都不会有人再补一次。
SENT=0
FAILED=0

for TO in $(printf '%s' "${NOTIFY_TO}" | tr ',; ' '\n' | sed '/^$/d'); do
  # 按探测结果分派，而不是把两种语法都试一遍：拿错的参数去试只会掩盖真正的错误
  case "$BODY_TOOL" in
    node)    TO="$TO" node -e "$JS_BODY" > "$BODY_FILE" 2>"$ERR_FILE" || true ;;
    "py -3") TO="$TO" py -3 -c "$PY_BODY" > "$BODY_FILE" 2>"$ERR_FILE" || true ;;
    *)       TO="$TO" "$BODY_TOOL" -c "$PY_BODY" > "$BODY_FILE" 2>"$ERR_FILE" || true ;;
  esac
  if [ ! -s "$BODY_FILE" ]; then
    # 把解释器的错误带出来：只报"没能生成报文体"的话，真正的原因（编码、语法）还得再查一遍
    echo "::error::邮件通知失败 → ${TO}：没能生成报文体（$BODY_TOOL）：$(head -c 200 "$ERR_FILE" 2>/dev/null | tr '\n' ' ')"
    FAILED=$((FAILED + 1))
    continue
  fi

  # 分开取「HTTP 状态码」与「curl 自己成没成功」：curl 连不上时 -w 仍会吐出 000，
  # 直接拼在状态码后面会变成 "000curl-failed" 这种既不像码也不像话的结果。
  if RESP=$(curl -sS -o "$RESP_FILE" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${NOTIFY_TOKEN}" \
    -H "Content-Type: application/json" \
    -d @"$BODY_FILE" "$NOTIFY_URL" 2>"$ERR_FILE"); then
    CODE="$RESP"
  else
    CODE="curl-failed"
  fi
  case "$CODE" in
    2*) echo "已发邮件通知 → ${TO}（HTTP ${CODE}）"; SENT=$((SENT + 1)) ;;
    *)
      # 响应体为空时（连接根本没建起来）改用 curl 自己的错误行，否则报出来的是一段空白
      DETAIL="$(head -c 300 "$RESP_FILE" 2>/dev/null)"
      [ -n "$DETAIL" ] || DETAIL="$(head -c 200 "$ERR_FILE" 2>/dev/null | tr '\n' ' ')"
      echo "::error::邮件通知失败 → ${TO}（HTTP ${CODE}）：${DETAIL}"
      FAILED=$((FAILED + 1))
      ;;
  esac
done

if [ "$FAILED" -gt 0 ]; then
  echo "::error::红灯邮件未送达：成功 ${SENT} 封、失败 ${FAILED} 封（端点 ${NOTIFY_URL}）"
  exit 1
fi

echo "红灯邮件已送达：${SENT} 封"
exit 0
