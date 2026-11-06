#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec uv run --no-sync uvicorn novelcomic_agent.main:app --host 0.0.0.0 --port 18791
