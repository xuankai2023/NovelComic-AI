#!/usr/bin/env bash
# Agent blue/green release.
# deploy-code updates the checkout and dependencies without restarting.
# restart waits up to HEALTH_TIMEOUT seconds for /health.
# drain polls /preview/active_runs count and exits 2 on timeout.
# release keeps the old ALB target registered until the new slot is healthy.
# A drain timeout does not delete checkpoints and does not fail the release.
# External /health must succeed or release exits 1 before the success line.
# Owner: novelcomic-platform Review by: 2026-12-31
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-/home/ec2-user/novelcomic-agent}"
BLUE_PORT="${BLUE_PORT:-18791}"
GREEN_PORT="${GREEN_PORT:-18792}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-600}"
DEFAULT_DRAIN_MAX_WAIT="${DEFAULT_DRAIN_MAX_WAIT:-900}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-5}"
ALB_HEALTH_WAIT="${ALB_HEALTH_WAIT:-240}"
ALB_HEALTH_POLL="${ALB_HEALTH_POLL:-3}"
UNIT_PREFIX="${UNIT_PREFIX:-novelcomic-agent}"
SUDO="${SUDO-sudo}"
UV_BIN="${UV_BIN:-}"
RUN_LOCAL="${RUN_LOCAL:-0}"
SSH_HOST="${SSH_HOST:-agent-host}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-/home/ec2-user/novelcomic-agent/scripts/deploy/deploy.sh}"
INSTANCE_ID="${INSTANCE_ID:-}"
TG_ARN="${TG_ARN:-}"
FORCE_DRAIN_SKIP="${FORCE_DRAIN_SKIP:-false}"
EXTERNAL_HEALTH_URL="${EXTERNAL_HEALTH_URL:-}"

log() { echo "[deploy $(date +%H:%M:%S)] $*" >&2; }
fail() { echo "[deploy ERROR] $*" >&2; exit 1; }

slot_port() {
  case "$1" in
    blue) echo "$BLUE_PORT" ;;
    green) echo "$GREEN_PORT" ;;
    *) fail "未知 slot: $1（要 blue 或 green）" ;;
  esac
}

slot_unit() { echo "${UNIT_PREFIX}-$1.service"; }
slot_health_url() { echo "http://127.0.0.1:$(slot_port "$1")/health"; }
slot_drain_url() { echo "http://127.0.0.1:$(slot_port "$1")/preview/drain"; }
slot_active_url() { echo "http://127.0.0.1:$(slot_port "$1")/preview/active_runs"; }

parse_slot_arg() {
  local arg="${1:-}"
  case "$arg" in
    --slot=*) echo "${arg#--slot=}" ;;
    *) fail "缺少 --slot=blue|green 参数" ;;
  esac
}

run_as_root() {
  if [ -n "${SUDO:-}" ]; then
    "$SUDO" "$@"
  else
    "$@"
  fi
}

uv_sync() {
  if [ -n "$UV_BIN" ]; then
    "$UV_BIN" sync
    return
  fi
  if [ -x /home/ec2-user/.local/bin/uv ]; then
    /home/ec2-user/.local/bin/uv sync
    return
  fi
  uv sync
}

run_remote() {
  if [ "$RUN_LOCAL" = "1" ]; then
    bash "$SCRIPT_DIR/deploy.sh" "$@"
    return
  fi
  local quoted
  quoted="$(printf '%q ' "$@")"
  # shellcheck disable=SC2029
  ssh "$SSH_HOST" "bash $(printf '%q' "$DEPLOY_SCRIPT") ${quoted}"
}

skip_drain() {
  case "$FORCE_DRAIN_SKIP" in
    true|TRUE|1) return 0 ;;
    *) return 1 ;;
  esac
}

wait_health() {
  local slot="$1"
  local url
  url="$(slot_health_url "$slot")"
  log "等待 ${url}（max=${HEALTH_TIMEOUT}s）"
  local i
  for i in $(seq 1 "$HEALTH_TIMEOUT"); do
    if curl -fsS -m 3 "$url" >/dev/null 2>&1; then
      log "agent-$slot /health OK（${i}s）"
      return 0
    fi
    sleep 1
  done
  fail "agent-$slot /health ${HEALTH_TIMEOUT}s 内未通过"
}

cmd_deploy_code() {
  log "deploy-code：git reset --hard origin/main，然后 uv sync，不重启"
  cd "$REPO_DIR"
  local before after
  before="$(git rev-parse --short HEAD)"
  git fetch origin main
  git checkout main 2>/dev/null || git checkout -B main origin/main
  git reset --hard origin/main
  after="$(git rev-parse --short HEAD)"
  log "$before → $after"
  uv_sync
  log "代码已更新到 ${after}，进程仍在跑旧代码"
  echo "$after"
}

cmd_restart() {
  local slot
  slot="$(parse_slot_arg "${1:-}")"
  local unit
  unit="$(slot_unit "$slot")"
  log "systemctl restart $unit"
  run_as_root systemctl restart "$unit"
  wait_health "$slot"
}

cmd_drain() {
  local slot=""
  local max_wait="$DEFAULT_DRAIN_MAX_WAIT"
  local arg
  for arg in "$@"; do
    case "$arg" in
      --slot=*) slot="${arg#--slot=}" ;;
      --max-wait=*) max_wait="${arg#--max-wait=}" ;;
      *) fail "未知参数: $arg" ;;
    esac
  done
  [ -n "$slot" ] || fail "缺少 --slot=blue|green"

  log "POST $(slot_drain_url "$slot")"
  curl -fsS -m 5 -X POST "$(slot_drain_url "$slot")" >/dev/null \
    || fail "调用 /preview/drain 失败：agent-$slot 可能已死"

  log "轮询 count==0（max_wait=${max_wait}s）"
  local start_ts elapsed count
  start_ts="$(date +%s)"
  while true; do
    count="$(
      curl -fsS -m 3 "$(slot_active_url "$slot")" 2>/dev/null \
        | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin)["count"])
except Exception:
    raise SystemExit(1)' \
        || echo "?"
    )"
    elapsed="$(( $(date +%s) - start_ts ))"
    if [ "$count" = "0" ]; then
      log "agent-$slot count=0（${elapsed}s）"
      return 0
    fi
    if [ "$elapsed" -ge "$max_wait" ]; then
      log "排水超时（${elapsed}s，count=${count}），退出码 2。checkpoint 保留"
      return 2
    fi
    log "${elapsed}s elapsed, agent-$slot count=${count}"
    sleep "$DRAIN_POLL_SECONDS"
  done
}

cmd_select_slot() {
  local json_file=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      --health-json=*) json_file="${arg#--health-json=}" ;;
      *) fail "未知参数: $arg" ;;
    esac
  done

  local json
  if [ -n "$json_file" ]; then
    json="$(cat "$json_file")"
  else
    [ -n "$TG_ARN" ] || fail "缺少 TG_ARN"
    json="$(
      aws elbv2 describe-target-health \
        --target-group-arn "$TG_ARN" \
        --query 'TargetHealthDescriptions[*].{Port:Target.Port,State:TargetHealth.State}' \
        --output json
    )"
  fi

  python3 -c '
import json, sys
blue_port = int(sys.argv[1])
green_port = int(sys.argv[2])
rows = json.loads(sys.argv[3] or "[]")
if not isinstance(rows, list):
    rows = []

def state_for(port: int) -> str:
    for row in rows:
        try:
            row_port = int(row.get("Port", -1))
        except (TypeError, ValueError):
            continue
        if row_port == port:
            return str(row.get("State") or "")
    return ""

blue = state_for(blue_port)
green = state_for(green_port)
if blue == "healthy" and green == "healthy":
    sys.stderr.write("TG 状态异常：两边都是 healthy\n")
    raise SystemExit(1)
if blue == "healthy" and green != "healthy":
    active, target, port = "blue", "green", green_port
elif green == "healthy" and blue != "healthy":
    active, target, port = "green", "blue", blue_port
elif blue == "" and green == "":
    active, target, port = "none", "blue", blue_port
else:
    sys.stderr.write(f"TG 状态异常：blue={blue} green={green}\n")
    raise SystemExit(1)
print(f"active={active}")
print(f"target={target}")
print(f"target_port={port}")
' "$BLUE_PORT" "$GREEN_PORT" "$json"
}

wait_alb_healthy() {
  local port="$1"
  local start_ts state elapsed
  start_ts="$(date +%s)"
  while true; do
    state="$(
      aws elbv2 describe-target-health \
        --target-group-arn "$TG_ARN" \
        --targets "Id=${INSTANCE_ID},Port=${port}" \
        --query 'TargetHealthDescriptions[0].TargetHealth.State' \
        --output text
    )"
    if [ "$state" = "healthy" ]; then
      log "ALB target :${port} healthy"
      return 0
    fi
    elapsed="$(( $(date +%s) - start_ts ))"
    if [ "$elapsed" -ge "$ALB_HEALTH_WAIT" ]; then
      fail "target :${port} ${ALB_HEALTH_WAIT}s 内未达 healthy，旧槽仍在目标组里"
    fi
    sleep "$ALB_HEALTH_POLL"
  done
}

cmd_release() {
  [ -n "$TG_ARN" ] || fail "缺少 TG_ARN"
  [ -n "$INSTANCE_ID" ] || fail "缺少 INSTANCE_ID"

  local slot_out active target target_port drain_note
  drain_note=""
  if ! slot_out="$(cmd_select_slot)"; then
    exit 1
  fi
  active="$(printf '%s\n' "$slot_out" | sed -n 's/^active=//p')"
  target="$(printf '%s\n' "$slot_out" | sed -n 's/^target=//p')"
  target_port="$(printf '%s\n' "$slot_out" | sed -n 's/^target_port=//p')"
  [ -n "$active" ] && [ -n "$target" ] && [ -n "$target_port" ] || fail "认槽失败"
  log "active=$active target=$target port=$target_port"

  run_remote deploy-code
  run_remote restart "--slot=${target}"

  log "register target :${target_port}"
  aws elbv2 register-targets \
    --target-group-arn "$TG_ARN" \
    --targets "Id=${INSTANCE_ID},Port=${target_port}"

  wait_alb_healthy "$target_port"

  if [ "$active" = "none" ]; then
    log "目标组原先为空，没有旧槽需要摘除"
  else
    local old_port
    old_port="$(slot_port "$active")"
    log "deregister old :${old_port}"
    aws elbv2 deregister-targets \
      --target-group-arn "$TG_ARN" \
      --targets "Id=${INSTANCE_ID},Port=${old_port}"

    if skip_drain; then
      log "FORCE_DRAIN_SKIP：跳过 drain，仍重启旧槽"
    else
      set +e
      run_remote drain "--slot=${active}" "--max-wait=${DEFAULT_DRAIN_MAX_WAIT}"
      local drain_code=$?
      set -e
      if [ "$drain_code" -eq 2 ]; then
        # 排水超时继续发布，成功通知保留 timeout 备注。
        # Owner: novelcomic-platform Review by: 2026-12-31
        drain_note=" (drain timed out)"
        log "drain 超时，发布继续，非终态 checkpoint 仍留在 Redis"
      elif [ "$drain_code" -ne 0 ]; then
        fail "drain 失败，退出码 ${drain_code}"
      fi
    fi

    run_remote restart "--slot=${active}"
  fi

  if [ -n "$EXTERNAL_HEALTH_URL" ]; then
    if ! curl -fsS -m 5 "$EXTERNAL_HEALTH_URL"; then
      echo "::error::外部 /health 失败" >&2
      exit 1
    fi
  fi
  local message="release 完成 active_was=${active} target=${target}${drain_note}"
  log "$message"
  if [ -n "${NOTIFY_WEBHOOK:-}" ]; then
    if ! curl -fsS -m 5 -H "Content-Type: application/json" \
      -d "{\"text\":\"${message}\"}" "$NOTIFY_WEBHOOK"; then
      echo "::warning::通知 webhook 失败，不证明 run 和 callback" >&2
    fi
  fi
}

usage() {
  cat <<EOF >&2
用法：$0 SUBCOMMAND [args...]

子命令：
  deploy-code                         git reset --hard origin/main，uv sync，不重启
  restart --slot=blue|green           systemctl restart，最多等 /health ${HEALTH_TIMEOUT}s
  drain --slot=blue|green [--max-wait=900]
                                      POST /preview/drain，轮询 count，超时退出码 2
  select-slot [--health-json=FILE]    认 ALB 槽：恰好一个 healthy，空组则目标是 blue
  release                             deploy-code → restart 目标 → register → healthy → deregister → drain → restart 旧槽
EOF
}

case "${1:-}" in
  deploy-code) shift; cmd_deploy_code "$@" ;;
  restart) shift; cmd_restart "$@" ;;
  drain) shift; cmd_drain "$@" ;;
  select-slot) shift; cmd_select_slot "$@" ;;
  release) shift; cmd_release "$@" ;;
  "") usage; exit 1 ;;
  *) fail "未知子命令：$1" ;;
esac
