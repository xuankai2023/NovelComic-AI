import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "deploy-consumer-bluegreen-prod.sh"
CONSUMER_ROOT = SCRIPT.parent.parent


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def _install_fakes(bin_dir: Path) -> None:
    _write_executable(
        bin_dir / "sudo",
        """#!/bin/bash
if [ "${1:-}" = "-n" ]; then
  exit 0
fi
exec "$@"
""",
    )
    _write_executable(
        bin_dir / "git",
        """#!/bin/bash
echo "git $*" >> "$TRACE_LOG"
if [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then
  printf '%s\\n' main
  exit 0
fi
exit 0
""",
    )
    _write_executable(
        bin_dir / "curl",
        """#!/bin/bash
echo "curl $*" >> "$TRACE_LOG"
url=""
method="GET"
previous=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
  if [ "$previous" = "-X" ]; then
    method="$arg"
  fi
  previous="$arg"
done
port=$(printf '%s' "$url" | sed -n 's#.*://127.0.0.1:\\([0-9][0-9]*\\)/.*#\\1#p')
path=${url#*://127.0.0.1:${port}}
if [ "$path" = "/readyz" ] && [ "$port" = "${READYZ_FAIL_PORT:-}" ]; then
  exit 22
fi
if [ "$url" = "$PUBLIC_HEALTH_URL" ]; then
  printf '%s\\n' "{\\"status\\":\\"ok\\",\\"instance_id\\":\\"${PUBLIC_INSTANCE_ID:-green}\\"}"
  exit 0
fi
if [ "$path" = "/health" ]; then
  color="blue"
  if [ "$port" = "9001" ]; then
    color="green"
  fi
  printf '%s\\n' "{\\"status\\":\\"ok\\",\\"instance_id\\":\\"${color}\\"}"
  exit 0
fi
if [ "$path" = "/ops/consumer/active" ] || [ "$path" = "/ops/consumer/drain" ]; then
  exit 0
fi
if [ "$path" = "/ops/consumer/status" ]; then
  printf '%s\\n' \\
    "{\\"inflight_count\\":${INFLIGHT_COUNT:-0},\\"intake_state\\":\\"${INTAKE_STATE:-STOPPED}\\"}"
  exit 0
fi
exit 0
""",
    )
    _write_executable(
        bin_dir / "systemctl",
        """#!/bin/bash
echo "systemctl $*" >> "$TRACE_LOG"
if [ "${1:-}" = "show" ]; then
  printf '%s\\n' "$EXPECTED_WORKDIR"
fi
if [ "${1:-}" = "stop" ]; then
  echo "stop ${2:-}" >> "$SYSTEMCTL_STOP_LOG"
fi
exit 0
""",
    )
    _write_executable(
        bin_dir / "nginx",
        """#!/bin/bash
echo "nginx $*" >> "$TRACE_LOG"
if [ "${1:-}" = "-t" ] && [ "${NGINX_TEST_FAIL:-0}" = "1" ]; then
  if grep -q "127.0.0.1:9001" "$NGINX_CONF"; then
    exit 1
  fi
fi
exit 0
""",
    )
    _write_executable(
        bin_dir / "redis-cli",
        """#!/bin/bash
echo "redis-cli $*" >> "$REDIS_LOG"
exit 0
""",
    )


def _layout(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (tmp_path / "backups").mkdir()
    _install_fakes(bin_dir)
    nginx_conf = tmp_path / "consumer.conf"
    nginx_conf.write_text("upstream consumer {\n    server 127.0.0.1:9000;\n}\n", encoding="utf-8")
    state_file = tmp_path / "active_consumer"
    state_file.write_text("blue\n", encoding="utf-8")
    (tmp_path / "trace.log").write_text("", encoding="utf-8")
    (tmp_path / "stop.log").write_text("", encoding="utf-8")
    (tmp_path / "redis.log").write_text("", encoding="utf-8")
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{bin_dir}:{env.get('PATH', '')}",
            "TRACE_LOG": str(tmp_path / "trace.log"),
            "SYSTEMCTL_STOP_LOG": str(tmp_path / "stop.log"),
            "REDIS_LOG": str(tmp_path / "redis.log"),
            "EXPECTED_WORKDIR": str(CONSUMER_ROOT.resolve()),
            "STATE_FILE": str(state_file),
            "NGINX_CONF": str(nginx_conf),
            "BACKUP_DIR": str(tmp_path / "backups"),
            "PUBLIC_HEALTH_URL": "http://127.0.0.1:8000/health",
            "HEALTH_CHECK_TIMEOUT": "0",
            "HEALTH_POLL_SECONDS": "0",
            "PUBLIC_HEALTH_ATTEMPTS": "1",
            "DRAIN_TIMEOUT": "0",
            "DRAIN_POLL_SECONDS": "0",
            "STOPPED_WAIT_ATTEMPTS": "1",
            "STOPPED_WAIT_SECONDS": "0",
            "LARK_WEBHOOK": "",
            "SUDO": "sudo",
            "READYZ_FAIL_PORT": "",
            "PUBLIC_INSTANCE_ID": "green",
            "INFLIGHT_COUNT": "0",
            "INTAKE_STATE": "STOPPED",
            "NGINX_TEST_FAIL": "0",
            "RELEASE_SMOKE_CMD": "true",
            "RUN_VERIFY_BLUEGREEN_DRAIN": "0",
            "VERIFY_DRAIN_CMD": "",
        }
    )
    return nginx_conf, state_file, env


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_standby_readyz_failure_keeps_old_nginx_and_color(tmp_path: Path) -> None:
    nginx_conf, state_file, env = _layout(tmp_path)
    env["READYZ_FAIL_PORT"] = "9001"

    result = _run(env)

    assert result.returncode != 0, result.stderr
    assert "server 127.0.0.1:9000;" in nginx_conf.read_text(encoding="utf-8")
    assert "9001" not in nginx_conf.read_text(encoding="utf-8")
    assert state_file.read_text(encoding="utf-8").strip() == "blue"
    trace = (tmp_path / "trace.log").read_text(encoding="utf-8")
    assert "systemctl restart novelcomic-consumer-green" in trace
    assert "/ops/consumer/drain" not in trace
    assert (tmp_path / "stop.log").read_text(encoding="utf-8") == ""
    assert (tmp_path / "redis.log").read_text(encoding="utf-8") == ""


def test_public_instance_mismatch_leaves_old_instance_active(tmp_path: Path) -> None:
    nginx_conf, state_file, env = _layout(tmp_path)
    env["PUBLIC_INSTANCE_ID"] = "blue"

    result = _run(env)

    assert result.returncode != 0, result.stderr
    assert "旧实例仍是 ACTIVE" in result.stderr
    assert "server 127.0.0.1:9000;" in nginx_conf.read_text(encoding="utf-8")
    assert state_file.read_text(encoding="utf-8").strip() == "blue"
    trace = (tmp_path / "trace.log").read_text(encoding="utf-8")
    assert "/ops/consumer/active" in trace
    assert "/ops/consumer/drain" not in trace
    assert (tmp_path / "stop.log").read_text(encoding="utf-8") == ""


def test_cutover_stops_old_after_inflight_zero_and_writes_new_color(tmp_path: Path) -> None:
    nginx_conf, state_file, env = _layout(tmp_path)

    result = _run(env)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "server 127.0.0.1:9001;" in nginx_conf.read_text(encoding="utf-8")
    assert state_file.read_text(encoding="utf-8").strip() == "green"
    trace = (tmp_path / "trace.log").read_text(encoding="utf-8")
    pull_at = trace.index("git pull --ff-only")
    restart_at = trace.index("systemctl restart novelcomic-consumer-green")
    assert pull_at < restart_at
    assert trace.index("/ops/consumer/active") < trace.index("nginx -s reload")
    assert trace.index("nginx -s reload") < trace.index("/ops/consumer/drain")
    assert "stop novelcomic-consumer-blue" in (tmp_path / "stop.log").read_text(encoding="utf-8")
    redis_log = (tmp_path / "redis.log").read_text(encoding="utf-8")
    assert 'SET opencreator:consumer:intake:blue STOPPED' in redis_log
    assert "DEL opencreator:consumer:inflight:blue" in redis_log
    assert "DEL opencreator:consumer:heartbeat:blue" in redis_log
    assert redis_log.index("SET ") < redis_log.index("DEL opencreator:consumer:inflight:blue")


def test_inflight_timeout_still_stops_and_clears_keys(tmp_path: Path) -> None:
    _nginx_conf, state_file, env = _layout(tmp_path)
    env["INFLIGHT_COUNT"] = "4"

    result = _run(env)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "排空超时" in result.stdout
    assert state_file.read_text(encoding="utf-8").strip() == "green"
    assert "stop novelcomic-consumer-blue" in (tmp_path / "stop.log").read_text(encoding="utf-8")
    assert "DEL opencreator:consumer:inflight:blue" in (tmp_path / "redis.log").read_text(
        encoding="utf-8"
    )


def test_smoke_failure_restores_old_slot_and_skips_success(tmp_path: Path) -> None:
    nginx_conf, state_file, env = _layout(tmp_path)
    env["RELEASE_SMOKE_CMD"] = "exit 1"

    result = _run(env)

    assert result.returncode != 0
    assert "发布前冒烟失败，流量已指回 blue" in result.stderr
    assert "server 127.0.0.1:9000;" in nginx_conf.read_text(encoding="utf-8")
    assert "9001" not in nginx_conf.read_text(encoding="utf-8")
    assert state_file.read_text(encoding="utf-8").strip() == "blue"
    assert "活跃实例已记录" not in result.stdout
    assert "蓝绿部署成功" not in result.stdout
    assert (tmp_path / "stop.log").read_text(encoding="utf-8") == ""


def test_verify_drain_failure_does_not_record_success(tmp_path: Path) -> None:
    nginx_conf, state_file, env = _layout(tmp_path)
    env["RUN_VERIFY_BLUEGREEN_DRAIN"] = "1"
    env["VERIFY_DRAIN_CMD"] = "exit 1"

    result = _run(env)

    assert result.returncode != 0
    assert "verify_bluegreen_drain 未到 0" in result.stderr
    assert "不代替 Publisher 和 Agent" in (
        Path(__file__).resolve().parents[1] / "deploy" / "deploy-consumer-bluegreen-prod.sh"
    ).read_text(encoding="utf-8")
    assert "server 127.0.0.1:9000;" in nginx_conf.read_text(encoding="utf-8")
    assert state_file.read_text(encoding="utf-8").strip() == "blue"
    assert "活跃实例已记录" not in result.stdout
    assert (tmp_path / "stop.log").read_text(encoding="utf-8") == ""
