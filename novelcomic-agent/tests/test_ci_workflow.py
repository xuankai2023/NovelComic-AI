from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CI = ROOT / ".github" / "workflows" / "ci.yml"
DEPLOY = ROOT / ".github" / "workflows" / "main-deploy.yml"


def parse_steps(text: str) -> list[dict[str, str | bool]]:
    steps: list[dict[str, str | bool]] = []
    current: dict[str, str | bool] | None = None
    for line in text.splitlines():
        if line.startswith("      - name:"):
            if current is not None:
                steps.append(current)
            current = {
                "name": line.split(":", 1)[1].strip(),
                "run": "",
                "continue_on_error": False,
                "if": "",
            }
            continue
        if current is None:
            continue
        stripped = line.strip()
        if stripped.startswith("continue-on-error:"):
            current["continue_on_error"] = stripped.endswith("true")
        elif stripped.startswith("if:"):
            current["if"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("run:"):
            current["run"] = stripped.split(":", 1)[1].strip()
    if current is not None:
        steps.append(current)
    return steps


def conclude(steps: list[dict[str, str | bool]], failing_run: str) -> tuple[str, list[str]]:
    failed = False
    ran: list[str] = []
    for step in steps:
        condition = str(step["if"] or "success()")
        if condition == "success()" and failed:
            continue
        if condition == "failure()" and not failed:
            continue
        ran.append(str(step["name"]))
        if failing_run in str(step["run"]) and not step["continue_on_error"]:
            failed = True
    return ("failure" if failed else "success", ran)


def test_pr_and_trunk_run_locked_pytest() -> None:
    text = CI.read_text(encoding="utf-8")
    steps = parse_steps(text)
    assert text.count("branches: [main, develop]") == 2
    assert "pull_request:" in text
    assert [step["run"] for step in steps if step["run"]] == [
        "uv sync --frozen --extra dev",
        "uv run pytest",
    ]
    assert "continue-on-error" not in text


def test_install_or_pytest_failure_fails_the_job() -> None:
    steps = parse_steps(CI.read_text(encoding="utf-8"))
    install_status, install_ran = conclude(steps, "uv sync --frozen --extra dev")
    assert install_status == "failure"
    assert "test" not in install_ran

    test_status, test_ran = conclude(steps, "uv run pytest")
    assert test_status == "failure"
    assert test_ran[-1] == "test"


def test_main_deploy_still_has_no_pytest() -> None:
    text = DEPLOY.read_text(encoding="utf-8")
    assert "pytest" not in text
    assert "branches: [main]" in text
    assert "workflow_dispatch:" in text
    assert "bash scripts/deploy/deploy.sh release" in text
