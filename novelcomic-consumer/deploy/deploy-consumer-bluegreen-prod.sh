#!/bin/bash
# Consumer blue/green cutover.
# Standby must be active and /readyz must succeed before Nginx changes.
# The public health instance_id must match the new color before the old
# instance is drained. The color file is written after the old process stops.
set -euo pipefail

ENV_NAME="${ENV_NAME:-PROD}"
EXPECTED_BRANCH="${EXPECTED_BRANCH:-main}"
STATE_FILE="${STATE_FILE:-/opt/opencreator/active_consumer}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/nginx-consumer.conf}"
BACKUP_DIR="${BACKUP_DIR:-/tmp}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-http://127.0.0.1:8000/health}"
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-120}"
HEALTH_POLL_SECONDS="${HEALTH_POLL_SECONDS:-2}"
PUBLIC_HEALTH_ATTEMPTS="${PUBLIC_HEALTH_ATTEMPTS:-10}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-1800}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-10}"
STOPPED_WAIT_ATTEMPTS="${STOPPED_WAIT_ATTEMPTS:-5}"
STOPPED_WAIT_SECONDS="${STOPPED_WAIT_SECONDS:-2}"
LARK_WEBHOOK="${LARK_WEBHOOK:-}"
SUDO="${SUDO:-sudo}"
BLUE_SERVICE="${BLUE_SERVICE:-novelcomic-consumer-blue}"
GREEN_SERVICE="${GREEN_SERVICE:-novelcomic-consumer-green}"
BLUE_PORT=9000
GREEN_PORT=9001

export NGINX_CONF

log_info() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] $1"
}

log_success() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [SUCCESS] $1"
}

notify() {
  local title="$1"
  local content="$2"
  if [ -z "$LARK_WEBHOOK" ]; then
    return 0
  fi
  curl -s "$LARK_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"${title}: ${content}\"}" >/dev/null 2>&1 || true
}

fail() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $1" >&2
  notify "Consumer 蓝绿部署失败 (${ENV_NAME})" "$1"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令: $1"
}

run_as_root() {
  if [ -n "$SUDO" ]; then
    $SUDO "$@"
  else
    "$@"
  fi
}

json_field() {
  local body="$1"
  local field="$2"
  printf '%s' "$body" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\\{0,1\\}\\([^,\"}]*\\)\"\\{0,1\\}.*/\\1/p" | head -n 1
}

redis_cli() {
  if [ -n "${REDIS_URL:-}" ]; then
    redis-cli -u "$REDIS_URL" "$@"
  else
    redis-cli "$@"
  fi
}

check_service_workdir() {
  local service="$1"
  local workdir
  workdir=$(run_as_root systemctl show "$service" -p WorkingDirectory --value 2>/dev/null || true)
  if [ "$workdir" != "$EXPECTED_WORKDIR" ]; then
    fail "${service} WorkingDirectory 不匹配: ${workdir:-unknown}，期望 ${EXPECTED_WORKDIR}"
  fi
}

run_preflight_checks() {
  log_info "执行 Consumer 部署预检"
  local actual_dir
  actual_dir=$(pwd -P)
  if [ "$actual_dir" != "$EXPECTED_WORKDIR" ]; then
    fail "当前目录不是 Consumer 目录: ${actual_dir}，期望 ${EXPECTED_WORKDIR}"
  fi
  require_command git
  require_command curl
  require_command systemctl
  require_command nginx
  require_command redis-cli
  if [ -n "$SUDO" ] && ! run_as_root -n true 2>/dev/null; then
    fail "当前用户没有免密码 sudo 权限，无法切换 systemd/nginx"
  fi
  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  if [ "$current_branch" != "$EXPECTED_BRANCH" ] && [ "${ALLOW_NON_PROD_BRANCH:-0}" != "1" ]; then
    fail "当前分支是 ${current_branch}，期望 ${EXPECTED_BRANCH}"
  fi
  if [ -n "$(git status --porcelain)" ]; then
    fail "工作区存在未提交改动，请先处理后再部署"
  fi
  check_service_workdir "$BLUE_SERVICE"
  check_service_workdir "$GREEN_SERVICE"
  if [ ! -f "$NGINX_CONF" ]; then
    fail "Nginx 配置不存在: ${NGINX_CONF}"
  fi
  if ! grep -q "server 127.0.0.1:900[01]" "$NGINX_CONF"; then
    fail "Nginx upstream 不像 Consumer 蓝绿配置，请检查 ${NGINX_CONF}"
  fi
  if ! run_as_root nginx -t >/dev/null 2>&1; then
    fail "Nginx 配置校验失败，请检查 ${NGINX_CONF}"
  fi
  log_success "Consumer 部署预检通过"
}

switch_nginx_upstream() {
  NGINX_BACKUP="${BACKUP_DIR}/consumer-prod-nginx-$(date +%Y%m%d%H%M%S).conf"
  local edited
  run_as_root cp "$NGINX_CONF" "$NGINX_BACKUP"
  edited=$(mktemp)
  sed "s/server 127\\.0\\.0\\.1:[0-9][0-9]*/server 127.0.0.1:${STANDBY_PORT}/" "$NGINX_CONF" >"$edited"
  run_as_root cp "$edited" "$NGINX_CONF"
  rm -f "$edited"
  if ! run_as_root nginx -t >/dev/null 2>&1; then
    run_as_root cp "$NGINX_BACKUP" "$NGINX_CONF"
    run_as_root nginx -s reload >/dev/null 2>&1 || true
    fail "Nginx 配置校验失败，已回滚到 ${NGINX_BACKUP}"
  fi
  run_as_root nginx -s reload
}

run_release_smoke() {
  local slot_url="$1"
  if [ -n "${RELEASE_SMOKE_CMD:-}" ]; then
    SLOT_URL="$slot_url" bash -c "$RELEASE_SMOKE_CMD"
    return
  fi
  local py="${RELEASE_SMOKE_PY:-}"
  if [ -z "$py" ]; then
    py="$(CDPATH= cd "${SCRIPT_DIR}/../.." && pwd -P)/scripts/release_smoke.py"
  fi
  python3 "$py" \
    --slot-url "$slot_url" \
    --publisher-url "${SMOKE_PUBLISHER_URL:-}" \
    --consumer-url "${SMOKE_CONSUMER_URL:-$slot_url}" \
    --flow-id "${SMOKE_FLOW_ID:-}" \
    --email "${SMOKE_EMAIL:-}" \
    --password "${SMOKE_PASSWORD:-}" \
    --external-url "${SMOKE_EXTERNAL_URL:-}" \
    --notify-webhook "${SMOKE_NOTIFY_WEBHOOK:-}" \
    --webhook-secret "${CONSUMER_WEBHOOK_SECRET:-}" \
    --events-url "${SMOKE_EVENTS_URL:-}" \
    --log "${SMOKE_LOG:-/tmp/release-smoke.log}"
}

restore_nginx() {
  if [ -n "${NGINX_BACKUP:-}" ] && [ -f "$NGINX_BACKUP" ]; then
    run_as_root cp "$NGINX_BACKUP" "$NGINX_CONF"
    run_as_root nginx -s reload >/dev/null 2>&1 || true
  fi
}

wait_for_standby() {
  local started
  started=$(date +%s)
  while true; do
    if curl -fs "http://127.0.0.1:${STANDBY_PORT}/health" >/dev/null 2>&1 \
      && curl -fs -X POST "http://127.0.0.1:${STANDBY_PORT}/ops/consumer/active" >/dev/null 2>&1 \
      && curl -fs "http://127.0.0.1:${STANDBY_PORT}/readyz" >/dev/null 2>&1; then
      log_success "Standby (${STANDBY}) 已就绪"
      return 0
    fi
    if [ $(( $(date +%s) - started )) -ge "$HEALTH_CHECK_TIMEOUT" ]; then
      fail "Standby 实例启动超时: ${STANDBY_SERVICE}"
    fi
    sleep "$HEALTH_POLL_SECONDS"
  done
}

require_public_instance() {
  local attempt=1
  local body=""
  local instance_id=""
  while [ "$attempt" -le "$PUBLIC_HEALTH_ATTEMPTS" ]; do
    body=$(curl -fs "$PUBLIC_HEALTH_URL" 2>/dev/null || true)
    instance_id=$(json_field "$body" "instance_id")
    if [ "$instance_id" = "$STANDBY" ]; then
      log_success "对外 /health instance_id=${instance_id}"
      return 0
    fi
    if [ "$attempt" -eq "$PUBLIC_HEALTH_ATTEMPTS" ]; then
      break
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  restore_nginx
  fail "对外 /health 的 instance_id=${instance_id:-unknown}，期望 ${STANDBY}。旧实例仍是 ACTIVE"
}

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
cd "${SCRIPT_DIR}/.."
REPO_ROOT=$(pwd -P)
EXPECTED_WORKDIR="${EXPECTED_WORKDIR:-$REPO_ROOT}"
run_preflight_checks

run_as_root mkdir -p "$(dirname "$STATE_FILE")"
ACTIVE=$(cat "$STATE_FILE" 2>/dev/null || echo "blue")
ACTIVE=$(printf '%s' "$ACTIVE" | tr -d '[:space:]')
if [ "$ACTIVE" != "blue" ] && [ "$ACTIVE" != "green" ]; then
  fail "active_consumer 状态非法: ${ACTIVE}"
fi
if [ "$ACTIVE" = "blue" ]; then
  STANDBY="green"
  STANDBY_PORT=$GREEN_PORT
  ACTIVE_PORT=$BLUE_PORT
  ACTIVE_SERVICE="$BLUE_SERVICE"
  STANDBY_SERVICE="$GREEN_SERVICE"
else
  STANDBY="blue"
  STANDBY_PORT=$BLUE_PORT
  ACTIVE_PORT=$GREEN_PORT
  ACTIVE_SERVICE="$GREEN_SERVICE"
  STANDBY_SERVICE="$BLUE_SERVICE"
fi

log_info "Consumer 蓝绿部署开始 (${ENV_NAME})"
log_info "Active: ${ACTIVE} (port ${ACTIVE_PORT})"
log_info "Standby: ${STANDBY} (port ${STANDBY_PORT})"

log_info "拉取最新代码"
git pull --ff-only

log_info "启动 standby 实例 (${STANDBY})"
run_as_root systemctl reset-failed "$STANDBY_SERVICE" 2>/dev/null || true
run_as_root systemctl restart "$STANDBY_SERVICE"
wait_for_standby

log_info "切换 Nginx upstream → ${STANDBY} (port ${STANDBY_PORT})"
switch_nginx_upstream
require_public_instance

if ! run_release_smoke "http://127.0.0.1:${STANDBY_PORT}"; then
  restore_nginx
  fail "发布前冒烟失败，流量已指回 ${ACTIVE} (port ${ACTIVE_PORT})"
fi

log_info "排空旧实例 (${ACTIVE})"
if ! curl -fs "http://127.0.0.1:${ACTIVE_PORT}/health" >/dev/null 2>&1; then
  log_info "旧实例不可达，跳过 drain"
else
  curl -fs -X POST "http://127.0.0.1:${ACTIVE_PORT}/ops/consumer/drain" >/dev/null
  started=$(date +%s)
  while true; do
    status_body=$(curl -fs "http://127.0.0.1:${ACTIVE_PORT}/ops/consumer/status" 2>/dev/null || echo '{"inflight_count":0}')
    inflight=$(json_field "$status_body" "inflight_count")
    inflight=${inflight:-0}
    log_info "inflight_count=${inflight}"
    if [ "$inflight" = "0" ]; then
      break
    fi
    if [ $(( $(date +%s) - started )) -ge "$DRAIN_TIMEOUT" ]; then
      log_info "排空超时，强制停止旧实例"
      break
    fi
    sleep "$DRAIN_POLL_SECONDS"
  done
  stopped_attempt=1
  while [ "$stopped_attempt" -le "$STOPPED_WAIT_ATTEMPTS" ]; do
    status_body=$(curl -fs "http://127.0.0.1:${ACTIVE_PORT}/ops/consumer/status" 2>/dev/null || true)
    intake_state=$(json_field "$status_body" "intake_state")
    if [ "$intake_state" = "STOPPED" ]; then
      break
    fi
    if [ "$stopped_attempt" -eq "$STOPPED_WAIT_ATTEMPTS" ]; then
      break
    fi
    sleep "$STOPPED_WAIT_SECONDS"
    stopped_attempt=$((stopped_attempt + 1))
  done
fi

# verify_bluegreen_drain 只等 inflight_count 和 submitted_webhook_invocation_count。
# 它不代替 Publisher 和 Agent 的 /health、/readyz。
if [ "${RUN_VERIFY_BLUEGREEN_DRAIN:-0}" = "1" ]; then
  if [ -n "${VERIFY_DRAIN_CMD:-}" ]; then
    if ! bash -c "$VERIFY_DRAIN_CMD"; then
      restore_nginx
      fail "verify_bluegreen_drain 未到 0，发布不记成功"
    fi
  else
    verify_py="${VERIFY_DRAIN_PY:-${SCRIPT_DIR}/../scripts/verify_bluegreen_drain.py}"
    if ! python3 "$verify_py" \
      --base-url "http://127.0.0.1:${ACTIVE_PORT}" \
      --timeout-seconds "${DRAIN_VERIFY_TIMEOUT:-300}"; then
      restore_nginx
      fail "verify_bluegreen_drain 未到 0，发布不记成功"
    fi
  fi
fi

log_info "停止旧实例 (${ACTIVE})"
run_as_root systemctl stop "$ACTIVE_SERVICE"
log_info "清理旧实例 Redis 键"
redis_cli SET "opencreator:consumer:intake:${ACTIVE}" STOPPED
redis_cli DEL "opencreator:consumer:inflight:${ACTIVE}"
redis_cli DEL "opencreator:consumer:heartbeat:${ACTIVE}"

log_info "记录状态"
printf '%s\n' "$STANDBY" | run_as_root tee "$STATE_FILE" >/dev/null
log_success "活跃实例已记录: ${STANDBY}"
notify "Consumer 蓝绿部署成功 (${ENV_NAME})" "Active: ${STANDBY} (port ${STANDBY_PORT})"
