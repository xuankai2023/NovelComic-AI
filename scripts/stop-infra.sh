#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/compose.local.yml"
COMPOSE_ARGS=(--file "${COMPOSE_FILE}")

command -v docker >/dev/null 2>&1 || {
  echo "错误：未找到 docker。" >&2
  exit 1
}

if [[ -f "${ROOT_DIR}/.env" ]]; then
  COMPOSE_ARGS+=(--env-file "${ROOT_DIR}/.env")
fi

case "${1:-}" in
  "")
    docker compose "${COMPOSE_ARGS[@]}" down
    ;;
  --volumes)
    echo "警告：将同时删除本项目的本地基础设施数据卷。"
    docker compose "${COMPOSE_ARGS[@]}" down --volumes
    ;;
  *)
    echo "用法：$0 [--volumes]" >&2
    exit 2
    ;;
esac
