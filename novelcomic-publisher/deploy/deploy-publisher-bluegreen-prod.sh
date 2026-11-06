#!/bin/bash
# Publisher blue/green cutover.
# Standby must answer /readyz before Nginx or the color file changes.
# The old process stays up; a background loop stops it when active_ws is 0,
# the field cannot be read, or the wait reaches DRAIN_TIMEOUT.
set -euo pipefail

ENV_NAME="${ENV_NAME:-PROD}"
EXPECTED_BRANCH="${EXPECTED_BRANCH:-main}"
STATE_FILE="${STATE_FILE:-/opt/opencreator/active_publisher}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/publisher.conf}"
BACKUP_DIR="${BACKUP_DIR:-/tmp}"
READYZ_WAIT="${READYZ_WAIT:-80}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-3600}"
DRAIN_POLL_SECONDS="${DRAIN_POLL_SECONDS:-10}"
DRAIN_LOG="${DRAIN_LOG:-/tmp/publisher-prod-drain.log}"
DRAIN_PID_FILE="${DRAIN_PID_FILE:-/tmp/publisher-prod-drain.pid}"
LARK_WEBHOOK="${LARK_WEBHOOK:-}"
SUDO="${SUDO:-sudo}"
BLUE_SERVICE="${BLUE_SERVICE:-novelcomic-publisher-blue}"
GREEN_SERVICE="${GREEN_SERVICE:-novelcomic-publisher-green}"
BLUE_PORT=8001
GREEN_PORT=8002

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
  notify "Publisher 蓝绿部署失败 (${ENV_NAME})" "$1"
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

active_ws_from_body() {
  local body="$1"
  local value
  value=$(printf '%s' "$body" | sed -n 's/.*"active_ws"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)
  if [ -z "$value" ]; then
    printf '%s' "unknown"
    return 0
  fi
  printf '%s' "$value"
}

drain_old_publisher() {
  local elapsed=0
  local body=""
  local active_ws=""
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始排空旧实例 ${ACTIVE} (port ${ACTIVE_PORT})"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 超时时间: ${DRAIN_TIMEOUT}s"
  while [ "$elapsed" -lt "$DRAIN_TIMEOUT" ]; do
    body=$(curl -s "http://127.0.0.1:${ACTIVE_PORT}/readyz" 2>/dev/null || true)
    active_ws=$(active_ws_from_body "$body")
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] active_ws on ${ACTIVE}: ${active_ws}"
    if [ "$active_ws" = "0" ] || [ "$active_ws" = "unknown" ]; then
      if [ "$active_ws" = "0" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 所有连接已关闭，停止旧实例"
      else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 旧实例已读不到 active_ws，停止旧实例"
      fi
      run_as_root systemctl stop "$ACTIVE_SERVICE"
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] 完成"
      exit 0
    fi
    sleep "$DRAIN_POLL_SECONDS"
    elapsed=$((elapsed + DRAIN_POLL_SECONDS))
  done
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 超时，强制停止旧实例"
  run_as_root systemctl stop "$ACTIVE_SERVICE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 完成"
  exit 0
}

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
SCRIPT_PATH="${SCRIPT_DIR}/$(basename "$0")"

if [ "${1:-}" = "--drain" ]; then
  drain_old_publisher
fi

check_service_workdir() {
  local service="$1"
  local workdir
  workdir=$(run_as_root systemctl show "$service" -p WorkingDirectory --value 2>/dev/null || true)
  if [ "$workdir" != "$EXPECTED_WORKDIR" ]; then
    fail "${service} WorkingDirectory 不匹配: ${workdir:-unknown}，期望 ${EXPECTED_WORKDIR}"
  fi
}

run_preflight_checks() {
  log_info "[0/6] 执行 Prod 部署预检"
  local actual_dir
  actual_dir=$(pwd -P)
  if [ "$actual_dir" != "$EXPECTED_WORKDIR" ]; then
    fail "当前目录不是 Prod Publisher 目录: ${actual_dir}，期望 ${EXPECTED_WORKDIR}"
  fi

  require_command git
  require_command curl
  require_command systemctl
  require_command nginx

  if [ -n "$SUDO" ] && ! run_as_root -n true 2>/dev/null; then
    fail "当前用户没有免密码 sudo 权限，无法切换 systemd/nginx"
  fi

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  if [ "$current_branch" != "$EXPECTED_BRANCH" ] && [ "${ALLOW_NON_PROD_BRANCH:-0}" != "1" ]; then
    fail "当前分支是 ${current_branch}，期望 ${EXPECTED_BRANCH}；如需强制运行请设置 ALLOW_NON_PROD_BRANCH=1"
  fi

  if [ -n "$(git status --porcelain)" ]; then
    fail "工作区存在未提交改动，请先处理后再部署"
  fi

  check_service_workdir "$BLUE_SERVICE"
  check_service_workdir "$GREEN_SERVICE"

  if [ ! -f "$NGINX_CONF" ]; then
    fail "Nginx 配置不存在: ${NGINX_CONF}"
  fi

  if ! grep -q "server 127.0.0.1:800[12]" "$NGINX_CONF"; then
    fail "Nginx upstream 不像 Publisher 蓝绿配置，请检查 ${NGINX_CONF}"
  fi

  if ! run_as_root nginx -t >/dev/null 2>&1; then
    fail "Nginx 配置校验失败，请检查 ${NGINX_CONF}"
  fi
  log_success "Prod 部署预检通过"
}

switch_nginx_upstream() {
  local target_port="${1:-$STANDBY_PORT}"
  local backup="${BACKUP_DIR}/publisher-prod-nginx-$(date +%Y%m%d%H%M%S).conf"
  local edited
  run_as_root cp "$NGINX_CONF" "$backup"
  edited=$(mktemp)
  sed "s/server 127\\.0\\.0\\.1:[0-9][0-9]*/server 127.0.0.1:${target_port}/" "$NGINX_CONF" >"$edited"
  run_as_root cp "$edited" "$NGINX_CONF"
  rm -f "$edited"
  if ! run_as_root nginx -t >/dev/null 2>&1; then
    run_as_root cp "$backup" "$NGINX_CONF"
    run_as_root nginx -s reload >/dev/null 2>&1 || true
    fail "Nginx 配置校验失败，已回滚到 ${backup}"
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
    --publisher-url "${SMOKE_PUBLISHER_URL:-$slot_url}" \
    --consumer-url "${SMOKE_CONSUMER_URL:-}" \
    --flow-id "${SMOKE_FLOW_ID:-}" \
    --email "${SMOKE_EMAIL:-}" \
    --password "${SMOKE_PASSWORD:-}" \
    --external-url "${SMOKE_EXTERNAL_URL:-}" \
    --notify-webhook "${SMOKE_NOTIFY_WEBHOOK:-}" \
    --webhook-secret "${CONSUMER_WEBHOOK_SECRET:-}" \
    --events-url "${SMOKE_EVENTS_URL:-}" \
    --log "${SMOKE_LOG:-/tmp/release-smoke.log}"
}

wait_for_standby() {
  local attempt=1
  while [ "$attempt" -le "$READYZ_WAIT" ]; do
    if curl -fs "http://127.0.0.1:${STANDBY_PORT}/readyz" >/dev/null 2>&1; then
      log_success "Standby (${STANDBY}) 已就绪 (${attempt}s)"
      return 0
    fi
    if [ "$attempt" -eq "$READYZ_WAIT" ]; then
      fail "Standby 实例启动超时: ${STANDBY_SERVICE}"
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
}

cd "${SCRIPT_DIR}/.."
REPO_ROOT=$(pwd -P)
EXPECTED_WORKDIR="${EXPECTED_WORKDIR:-$REPO_ROOT}"
run_preflight_checks

run_as_root mkdir -p "$(dirname "$STATE_FILE")"
ACTIVE=$(cat "$STATE_FILE" 2>/dev/null || echo "blue")
ACTIVE=$(printf '%s' "$ACTIVE" | tr -d '[:space:]')
if [ "$ACTIVE" != "blue" ] && [ "$ACTIVE" != "green" ]; then
  fail "active_publisher 状态非法: ${ACTIVE}"
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

log_info "Publisher 蓝绿部署开始 (${ENV_NAME})"
log_info "Active: ${ACTIVE} (port ${ACTIVE_PORT})"
log_info "Standby: ${STANDBY} (port ${STANDBY_PORT})"

log_info "[1/6] 拉取最新代码"
git pull --ff-only
log_success "代码已更新"

log_info "[2/6] 启动 standby 实例 (${STANDBY})"
run_as_root systemctl reset-failed "$STANDBY_SERVICE" 2>/dev/null || true
run_as_root systemctl restart "$STANDBY_SERVICE"
log_info "等待 standby 服务就绪..."
wait_for_standby

log_info "[3/6] 切换 Nginx upstream → ${STANDBY} (port ${STANDBY_PORT})"
switch_nginx_upstream "$STANDBY_PORT"
log_success "Nginx 已切换到 ${STANDBY} (port ${STANDBY_PORT})"

if ! run_release_smoke "http://127.0.0.1:${STANDBY_PORT}"; then
  switch_nginx_upstream "$ACTIVE_PORT"
  fail "发布前冒烟失败，流量已指回 ${ACTIVE} (port ${ACTIVE_PORT})"
fi

log_info "[4/6] 记录状态"
printf '%s\n' "$STANDBY" | run_as_root tee "$STATE_FILE" >/dev/null
log_success "活跃实例已记录: ${STANDBY}"

log_info "[5/6] 后台启动旧实例排空任务"
export ACTIVE ACTIVE_PORT ACTIVE_SERVICE DRAIN_TIMEOUT DRAIN_POLL_SECONDS SUDO
nohup "$SCRIPT_PATH" --drain >>"$DRAIN_LOG" 2>&1 &
echo $! >"$DRAIN_PID_FILE"
log_success "排空任务已在后台启动 (PID: $!)"

log_info "[6/6] 部署完成"
log_success "Active: ${STANDBY} (port ${STANDBY_PORT})"
log_success "Draining: ${ACTIVE} (后台排空中，/readyz 仍为 200)"
notify "Publisher 蓝绿部署成功 (${ENV_NAME})" "Active: ${STANDBY} (port ${STANDBY_PORT}); Draining: ${ACTIVE}"
