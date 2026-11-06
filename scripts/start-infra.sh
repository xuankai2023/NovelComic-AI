#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/compose.local.yml"

command -v docker >/dev/null 2>&1 || {
  echo "错误：未找到 docker，请先安装并启动 Docker。" >&2
  exit 1
}

docker info >/dev/null 2>&1 || {
  echo "错误：Docker daemon 不可用。" >&2
  exit 1
}

COMPOSE_ARGS=(--file "${COMPOSE_FILE}")
if [[ -f "${ROOT_DIR}/.env" ]]; then
  COMPOSE_ARGS+=(--env-file "${ROOT_DIR}/.env")
else
  echo "提示：未发现 .env，将使用 compose.local.yml 中的本地默认值。"
fi

docker compose "${COMPOSE_ARGS[@]}" up --detach --wait
docker compose "${COMPOSE_ARGS[@]}" ps
