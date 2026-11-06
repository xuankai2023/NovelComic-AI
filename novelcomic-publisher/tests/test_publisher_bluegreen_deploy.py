import os
import signal
import subprocess
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "deploy-publisher-bluegreen-prod.sh"
PUBLISHER_ROOT = SCRIPT.parent.parent


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
  printf '%s\\n' "${GIT_BRANCH:-main}"
  exit 0
fi
if [ "$1" = "status" ]; then
  exit 0
fi
if [ "$1" = "pull" ]; then
  if [ "${GIT_PULL_FAIL:-0}" = "1" ]; then
    exit 1
  fi
  exit 0
fi
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "abc123def4567890"
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
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
done
port=$(printf '%s' "$url" | sed -n 's#.*://127.0.0.1:\\([0-9][0-9]*\\)/.*#\\1#p')
if [ -n "${READYZ_FAIL_PORT:-}" ] && [ "$port" = "$READYZ_FAIL_PORT" ]; then
  exit 22
fi
if [ -n "${ACTIVE_WS_PORT:-}" ] && [ "$port" = "$ACTIVE_WS_PORT" ]; then
  if [ "${ACTIVE_WS_VALUE:-2}" = "missing" ]; then
    printf '%s\\n' '{"status":"ok"}'
  else
    printf '%s\\n' "{\\"status\\":\\"ok\\",\\"active_ws\\":${ACTIVE_WS_VALUE:-2}}"
  fi
  exit 0
fi
printf '%s\\n' '{"status":"ok","active_ws":0}'
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
if [ "${1:-}" = "-t" ]; then
  if [ "${NGINX_TEST_FAIL:-0}" = "1" ] && grep -q "127.0.0.1:8002" "$NGINX_CONF"; then
    exit 1
  fi
fi
exit 0
""",
    )


def _base_env(root: Path, *, nginx_conf: Path, state_file: Path) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{root / 'bin'}:{env.get('PATH', '')}",
            "TRACE_LOG": str(root / "trace.log"),
            "SYSTEMCTL_STOP_LOG": str(root / "stop.log"),
            "EXPECTED_WORKDIR": str(PUBLISHER_ROOT.resolve()),
            "EXPECTED_BRANCH": "main",
            "STATE_FILE": str(state_file),
            "NGINX_CONF": str(nginx_conf),
            "BACKUP_DIR": str(root / "backups"),
            "DRAIN_LOG": str(root / "drain.log"),
            "DRAIN_PID_FILE": str(root / "drain.pid"),
            "LARK_WEBHOOK": "",
            "SUDO": "sudo",
            "READYZ_WAIT": "1",
            "DRAIN_TIMEOUT": "3600",
            "DRAIN_POLL_SECONDS": "30",
            "READYZ_FAIL_PORT": "",
            "ACTIVE_WS_PORT": "",
            "ACTIVE_WS_VALUE": "2",
            "NGINX_TEST_FAIL": "0",
            "GIT_PULL_FAIL": "0",
            "GIT_BRANCH": "main",
            "RELEASE_SMOKE_CMD": "true",
        }
    )
    return env


def _layout(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (tmp_path / "backups").mkdir()
    _install_fakes(bin_dir)
    nginx_conf = tmp_path / "publisher.conf"
    nginx_conf.write_text("upstream publisher {\n    server 127.0.0.1:8001;\n}\n", encoding="utf-8")
    state_file = tmp_path / "active_publisher"
    state_file.write_text("blue\n", encoding="utf-8")
    (tmp_path / "trace.log").write_text("", encoding="utf-8")
    (tmp_path / "stop.log").write_text("", encoding="utf-8")
    return nginx_conf, state_file, _base_env(tmp_path, nginx_conf=nginx_conf, state_file=state_file)


def _run(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _stop_drain(pid_file: Path) -> None:
    if not pid_file.exists():
        return
    raw = pid_file.read_text(encoding="utf-8").strip()
    if not raw:
        return
    pid = int(raw)
    subprocess.run(["pkill", "-P", str(pid)], check=False)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return


def test_script_does_not_create_publisher_maintenance_file() -> None:
    assert "publisher_maintenance" not in SCRIPT.read_text(encoding="utf-8")


def test_standby_readyz_failure_keeps_old_nginx_and_color(tmp_path: Path) -> None:
    nginx_conf, state_file, env = _layout(tmp_path)
    env["READYZ_FAIL_PORT"] = "8002"

    result = _run(env)

    assert result.returncode != 0, result.stderr
    assert "server 127.0.0.1:8001;" in nginx_conf.read_text(encoding="utf-8")
    assert "8002" not in nginx_conf.read_text(encoding="utf-8")
    assert state_file.read_text(encoding="utf-8").strip() == "blue"
    assert (tmp_path / "stop.log").read_text(encoding="utf-8") == ""
    trace = (tmp_path / "trace.log").read_text(encoding="utf-8")
    assert "git pull --ff-only" in trace
    assert "systemctl restart novelcomic-publisher-green" in trace
    assert "nginx -s reload" not in trace
    assert not (tmp_path / "drain.pid").exists()


def test_nginx_test_failure_restores_old_upstream_and_color(tmp_path: Path) -> None:
    nginx_conf, state_file, env = _layout(tmp_path)
    env["NGINX_TEST_FAIL"] = "1"

    result = _run(env)

    assert result.returncode != 0, result.stderr
    assert "server 127.0.0.1:8001;" in nginx_conf.read_text(encoding="utf-8")
    assert "8002" not in nginx_conf.read_text(encoding="utf-8")
    assert state_file.read_text(encoding="utf-8").strip() == "blue"
    assert (tmp_path / "stop.log").read_text(encoding="utf-8") == ""
    assert not (tmp_path / "drain.pid").exists()


def test_cutover_writes_new_color_and_leaves_old_process_running(tmp_path: Path) -> None:
    nginx_conf, state_file, env = _layout(tmp_path)
    env["ACTIVE_WS_PORT"] = "8001"
    env["ACTIVE_WS_VALUE"] = "2"
    pid_file = tmp_path / "drain.pid"
    try:
        result = _run(env)
        assert result.returncode == 0, result.stderr + result.stdout
        assert "server 127.0.0.1:8002;" in nginx_conf.read_text(encoding="utf-8")
        assert state_file.read_text(encoding="utf-8").strip() == "green"
        trace = (tmp_path / "trace.log").read_text(encoding="utf-8")
        assert trace.index("git pull --ff-only") < trace.index(
            "systemctl restart novelcomic-publisher-green"
        )
        assert "nginx -s reload" in trace
        deadline = time.time() + 2
        drain_log = tmp_path / "drain.log"
        while time.time() < deadline:
            if "active_ws on blue: 2" in drain_log.read_text(encoding="utf-8"):
                break
            time.sleep(0.05)
        else:
            raise AssertionError(drain_log.read_text(encoding="utf-8"))
        assert (tmp_path / "stop.log").read_text(encoding="utf-8") == ""
        pid = int(pid_file.read_text(encoding="utf-8").strip())
        os.kill(pid, 0)
    finally:
        _stop_drain(pid_file)


def test_drain_stops_when_active_ws_is_zero_or_unreadable(tmp_path: Path) -> None:
    _nginx_conf, _state_file, env = _layout(tmp_path)
    env["ACTIVE"] = "blue"
    env["ACTIVE_PORT"] = "8001"
    env["ACTIVE_SERVICE"] = "novelcomic-publisher-blue"
    env["ACTIVE_WS_PORT"] = "8001"
    env["ACTIVE_WS_VALUE"] = "0"

    zero = _run(env, "--drain")
    assert zero.returncode == 0, zero.stderr
    assert "stop novelcomic-publisher-blue" in (tmp_path / "stop.log").read_text(encoding="utf-8")

    (tmp_path / "stop.log").write_text("", encoding="utf-8")
    env["ACTIVE_WS_VALUE"] = "missing"
    missing = _run(env, "--drain")
    assert missing.returncode == 0, missing.stderr
    assert "active_ws on blue: unknown" in missing.stdout
    assert "stop novelcomic-publisher-blue" in (tmp_path / "stop.log").read_text(encoding="utf-8")


def test_drain_stops_when_the_wait_expires(tmp_path: Path) -> None:
    _nginx_conf, _state_file, env = _layout(tmp_path)
    env.update(
        {
            "ACTIVE": "green",
            "ACTIVE_PORT": "8002",
            "ACTIVE_SERVICE": "novelcomic-publisher-green",
            "ACTIVE_WS_PORT": "8002",
            "ACTIVE_WS_VALUE": "4",
            "DRAIN_TIMEOUT": "1",
            "DRAIN_POLL_SECONDS": "1",
        }
    )

    result = _run(env, "--drain")

    assert result.returncode == 0, result.stderr
    assert "超时，强制停止旧实例" in result.stdout
    assert "stop novelcomic-publisher-green" in (tmp_path / "stop.log").read_text(encoding="utf-8")


def test_smoke_failure_points_traffic_back_and_skips_success(tmp_path: Path) -> None:
    nginx_conf, state_file, env = _layout(tmp_path)
    env["RELEASE_SMOKE_CMD"] = "echo release-smoke >> \"$TRACE_LOG\"; exit 1"

    result = _run(env)

    assert result.returncode != 0
    assert "发布前冒烟失败，流量已指回 blue" in result.stderr
    assert "server 127.0.0.1:8001;" in nginx_conf.read_text(encoding="utf-8")
    assert "8002" not in nginx_conf.read_text(encoding="utf-8")
    assert state_file.read_text(encoding="utf-8").strip() == "blue"
    assert "部署完成" not in result.stdout
    assert "蓝绿部署成功" not in result.stdout
    assert not (tmp_path / "drain.pid").exists()
    trace = (tmp_path / "trace.log").read_text(encoding="utf-8")
    assert "nginx -s reload" in trace
    assert "release-smoke" in trace
