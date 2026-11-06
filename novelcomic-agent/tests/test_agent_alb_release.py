import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "deploy" / "deploy.sh"
WORKFLOW = Path(__file__).resolve().parents[1] / ".github" / "workflows" / "main-deploy.yml"


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def _install_fakes(bin_dir: Path) -> None:
    _write_executable(
        bin_dir / "git",
        """#!/bin/bash
echo "git $*" >> "$TRACE_LOG"
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "abc1234"
  exit 0
fi
exit 0
""",
    )
    _write_executable(
        bin_dir / "uv",
        """#!/bin/bash
echo "uv $*" >> "$TRACE_LOG"
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
if [ -n "${EXTERNAL_HEALTH_URL:-}" ] && [ "$url" = "$EXTERNAL_HEALTH_URL" ]; then
  if [ "${EXTERNAL_HEALTH_FAIL:-0}" = "1" ]; then
    exit 22
  fi
  printf '%s\\n' '{"status":"ok"}'
  exit 0
fi
if [ -n "${NOTIFY_WEBHOOK:-}" ] && [ "$url" = "$NOTIFY_WEBHOOK" ]; then
  if [ "${NOTIFY_WEBHOOK_FAIL:-0}" = "1" ]; then
    exit 22
  fi
  exit 0
fi
case "$url" in
  */health)
    if [ "${HEALTH_FAIL:-0}" = "1" ]; then
      exit 22
    fi
    printf '%s\\n' '{"status":"ok"}'
    ;;
  */preview/drain)
    printf '%s\\n' '{"shutting_down":true}'
    ;;
  */preview/active_runs)
    printf '%s\\n' "{\\"count\\":${ACTIVE_COUNT:-0}}"
    ;;
esac
exit 0
""",
    )
    _write_executable(
        bin_dir / "systemctl",
        """#!/bin/bash
echo "systemctl $*" >> "$TRACE_LOG"
exit 0
""",
    )
    _write_executable(
        bin_dir / "aws",
        """#!/bin/bash
echo "aws $*" >> "$TRACE_LOG"
joined="$*"
case "$joined" in
  *register-targets*|*deregister-targets*) exit 0 ;;
esac
case "$joined" in
  *--targets*)
    printf '%s\\n' "${TARGET_HEALTH_STATE:-initial}"
    exit 0
    ;;
esac
printf '%s\\n' "$TG_HEALTH_JSON"
exit 0
""",
    )


def _env(root: Path, **extra: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{root / 'bin'}:{env.get('PATH', '')}",
            "TRACE_LOG": str(root / "trace.log"),
            "REPO_DIR": str(root / "repo"),
            "UV_BIN": str(root / "bin" / "uv"),
            "SUDO": "",
            "RUN_LOCAL": "1",
            "HEALTH_TIMEOUT": "1",
            "DRAIN_POLL_SECONDS": "0",
            "DEFAULT_DRAIN_MAX_WAIT": "0",
            "ALB_HEALTH_WAIT": "0",
            "ALB_HEALTH_POLL": "0",
            "TG_ARN": "arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/agent/abc",
            "INSTANCE_ID": "i-test",
            "BLUE_PORT": "18791",
            "GREEN_PORT": "18792",
            "FORCE_DRAIN_SKIP": "false",
            "EXTERNAL_HEALTH_URL": "",
            "EXTERNAL_HEALTH_FAIL": "0",
            "NOTIFY_WEBHOOK": "",
            "NOTIFY_WEBHOOK_FAIL": "0",
            "HEALTH_FAIL": "0",
            "ACTIVE_COUNT": "0",
            "TARGET_HEALTH_STATE": "healthy",
            "TG_HEALTH_JSON": '[{"Port":18791,"State":"healthy"}]',
        }
    )
    env.update(extra)
    return env


def _layout(tmp_path: Path) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (tmp_path / "repo").mkdir()
    _install_fakes(bin_dir)
    (tmp_path / "trace.log").write_text("", encoding="utf-8")
    return _env(tmp_path)


def _run(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _trace(env: dict[str, str]) -> str:
    return Path(env["TRACE_LOG"]).read_text(encoding="utf-8")


def test_defaults_match_the_release_contract() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    assert "HEALTH_TIMEOUT:-600" in text
    assert "DEFAULT_DRAIN_MAX_WAIT:-900" in text
    assert "ALB_HEALTH_WAIT:-240" in text
    assert "redis-cli" not in text
    assert "git reset --hard origin/main" in text


def test_deploy_code_resets_main_and_does_not_restart(tmp_path: Path) -> None:
    env = _layout(tmp_path)

    result = _run(env, "deploy-code")

    assert result.returncode == 0, result.stderr
    trace = _trace(env)
    assert "git reset --hard origin/main" in trace
    assert "uv sync" in trace
    assert "systemctl" not in trace


def test_restart_waits_for_health_and_fails_when_it_never_arrives(tmp_path: Path) -> None:
    env = _layout(tmp_path)
    ok = _run(env, "restart", "--slot=green")
    assert ok.returncode == 0, ok.stderr
    assert "systemctl restart novelcomic-agent-green.service" in _trace(env)
    assert "http://127.0.0.1:18792/health" in _trace(env)

    (tmp_path / "trace.log").write_text("", encoding="utf-8")
    env["HEALTH_FAIL"] = "1"
    failed = _run(env, "restart", "--slot=blue")
    assert failed.returncode != 0
    assert "600" not in failed.stderr or "1s" in failed.stderr or "未通过" in failed.stderr
    assert "未通过" in failed.stderr


def test_drain_returns_zero_when_count_is_zero_and_two_on_timeout(tmp_path: Path) -> None:
    env = _layout(tmp_path)
    env["ACTIVE_COUNT"] = "0"
    done = _run(env, "drain", "--slot=blue", "--max-wait=900")
    assert done.returncode == 0, done.stderr
    assert "/preview/drain" in _trace(env)

    (tmp_path / "trace.log").write_text("", encoding="utf-8")
    env["ACTIVE_COUNT"] = "2"
    timed_out = _run(env, "drain", "--slot=green", "--max-wait=0")
    assert timed_out.returncode == 2, timed_out.stderr
    assert "checkpoint" in timed_out.stderr
    assert "redis-cli" not in _trace(env)


def test_select_slot_rules(tmp_path: Path) -> None:
    env = _layout(tmp_path)

    def select(body: str) -> subprocess.CompletedProcess[str]:
        health = tmp_path / "health.json"
        health.write_text(body, encoding="utf-8")
        return _run(env, "select-slot", f"--health-json={health}")

    one = select('[{"Port":18792,"State":"healthy"}]')
    assert one.returncode == 0, one.stderr
    assert "active=green" in one.stdout
    assert "target=blue" in one.stdout
    assert "target_port=18791" in one.stdout

    empty = select("[]")
    assert empty.returncode == 0, empty.stderr
    assert "active=none" in empty.stdout
    assert "target=blue" in empty.stdout

    both = select(
        '[{"Port":18791,"State":"healthy"},{"Port":18792,"State":"healthy"}]'
    )
    assert both.returncode == 1
    assert "两边都是 healthy" in both.stderr

    mixed = select('[{"Port":18791,"State":"initial"},{"Port":18792,"State":"initial"}]')
    assert mixed.returncode == 1


def test_unhealthy_target_leaves_the_old_slot_registered(tmp_path: Path) -> None:
    env = _layout(tmp_path)
    env["TARGET_HEALTH_STATE"] = "initial"

    result = _run(env, "release")

    assert result.returncode != 0, result.stderr
    trace = _trace(env)
    assert "register-targets" in trace
    assert "Port=18792" in trace
    assert "deregister-targets" not in trace
    assert "旧槽仍在目标组里" in result.stderr


def test_both_healthy_fails_before_register(tmp_path: Path) -> None:
    env = _layout(tmp_path)
    env["TG_HEALTH_JSON"] = (
        '[{"Port":18791,"State":"healthy"},{"Port":18792,"State":"healthy"}]'
    )

    result = _run(env, "release")

    assert result.returncode != 0
    assert "两边都是 healthy" in result.stderr
    assert "register-targets" not in _trace(env)


def test_empty_group_targets_blue_and_does_not_deregister(tmp_path: Path) -> None:
    env = _layout(tmp_path)
    env["TG_HEALTH_JSON"] = "[]"

    result = _run(env, "release")

    assert result.returncode == 0, result.stderr
    trace = _trace(env)
    assert "register-targets" in trace
    assert "Port=18791" in trace
    assert "deregister-targets" not in trace
    assert "systemctl restart novelcomic-agent-blue.service" in trace


def test_drain_timeout_still_restarts_the_old_slot(tmp_path: Path) -> None:
    env = _layout(tmp_path)
    env["ACTIVE_COUNT"] = "3"
    env["EXTERNAL_HEALTH_URL"] = "https://agent.example/health"

    result = _run(env, "release")

    assert result.returncode == 0, result.stderr
    trace = _trace(env)
    assert trace.index("git reset --hard origin/main") < trace.index(
        "systemctl restart novelcomic-agent-green.service"
    )
    assert trace.index("register-targets") < trace.index("deregister-targets")
    assert "Port=18791" in trace
    assert "/preview/drain" in trace
    assert "systemctl restart novelcomic-agent-blue.service" in trace
    assert "redis-cli" not in trace
    assert "release 完成 active_was=blue target=green (drain timed out)" in result.stderr
    assert "::warning::外部 /health 失败" not in result.stderr


def test_external_health_failure_exits_before_success(tmp_path: Path) -> None:
    env = _layout(tmp_path)
    env["EXTERNAL_HEALTH_URL"] = "https://agent.example/health"
    env["EXTERNAL_HEALTH_FAIL"] = "1"

    result = _run(env, "release")

    assert result.returncode != 0
    assert "::error::外部 /health 失败" in result.stderr
    assert "::warning::外部 /health 失败" not in result.stderr
    assert "release 完成" not in result.stderr
    assert "systemctl restart novelcomic-agent-blue.service" in _trace(env)


def test_notify_webhook_failure_is_a_warning(tmp_path: Path) -> None:
    env = _layout(tmp_path)
    env["NOTIFY_WEBHOOK"] = "https://hooks.example/notify"
    env["NOTIFY_WEBHOOK_FAIL"] = "1"

    result = _run(env, "release")

    assert result.returncode == 0, result.stderr
    assert "release 完成" in result.stderr
    assert "::warning::通知 webhook 失败，不证明 run 和 callback" in result.stderr


def test_force_drain_skip_still_restarts_the_old_slot(tmp_path: Path) -> None:
    env = _layout(tmp_path)
    env["ACTIVE_COUNT"] = "4"
    env["FORCE_DRAIN_SKIP"] = "true"

    result = _run(env, "release")

    assert result.returncode == 0, result.stderr
    trace = _trace(env)
    assert "/preview/drain" not in trace
    assert "systemctl restart novelcomic-agent-blue.service" in trace
    assert "deregister-targets" in trace


def test_workflow_invokes_release_and_keeps_force_drain_skip() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "force_drain_skip:" in text
    assert "cancel-in-progress: false" in text
    assert "bash scripts/deploy/deploy.sh release" in text
    assert "FORCE_DRAIN_SKIP:" in text
    assert "Owner: novelcomic-platform" in text
    assert "Review by: 2026-12-31" in text
    assert "exit 1" in SCRIPT.read_text(encoding="utf-8")
    assert "::warning::外部 /health 失败，不阻断发布" not in SCRIPT.read_text(encoding="utf-8")
