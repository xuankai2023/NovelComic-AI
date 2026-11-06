from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import nightly_matrix

MANIFEST_PATH = ROOT / "revision-manifest.json"
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "nightly-matrix.yml"


def _load() -> dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def _round(
    manifest: dict[str, object],
    artifact_dir: Path,
    execute,
    *,
    repo: Path | None = None,
    env: dict[str, str] | None = None,
) -> tuple[int, list[str]]:
    seen: list[str] = []

    def checkout(sha: str) -> Path:
        seen.append(sha)
        return artifact_dir / sha

    code = nightly_matrix.execute_round(
        manifest,
        artifact_dir=artifact_dir,
        repo=repo,
        execute=execute,
        checkout=checkout,
        env=env,
    )
    return code, seen


def test_manifest_lists_full_commits_and_omits_default_branch_head() -> None:
    manifest = _load()
    assert nightly_matrix.validate_manifest(manifest, ROOT) == []
    head = nightly_matrix.default_branch_head(ROOT)
    assert head not in MANIFEST_PATH.read_text(encoding="utf-8")
    assert manifest["frontend"]["new"] == manifest["publisher"]["new"] == manifest["agent"]["new"]
    assert manifest["frontend"]["old"] == manifest["publisher"]["old"]
    assert manifest["frontend"]["new"] != manifest["publisher"]["old"]
    assert manifest["owner"] == "novelcomic-platform"
    assert "pnpm test" in manifest["tests"]["frontend"]["commands"]
    assert "uv run pytest" in manifest["tests"]["publisher"]["commands"]


def test_missing_key_fails_before_any_test_command(tmp_path: Path) -> None:
    manifest = _load()
    del manifest["consumer"]
    calls: list[nightly_matrix.CommandRequest] = []

    code, seen = _round(manifest, tmp_path, lambda request: calls.append(request) or 0)

    assert code == 1
    assert calls == []
    assert seen == []
    assert "缺少键 consumer" in (tmp_path / "logs.txt").read_text(encoding="utf-8")
    assert (tmp_path / "owner.txt").read_text(encoding="utf-8").strip() == "novelcomic-platform"


def test_default_branch_head_in_manifest_fails_before_tests(tmp_path: Path) -> None:
    manifest = _load()
    manifest["publisher"]["old"] = nightly_matrix.default_branch_head(ROOT)
    calls: list[nightly_matrix.CommandRequest] = []

    code, seen = _round(
        manifest,
        tmp_path,
        lambda request: calls.append(request) or 0,
        repo=ROOT,
    )

    assert code == 1
    assert calls == []
    assert seen == []
    assert "默认分支 HEAD" in (tmp_path / "logs.txt").read_text(encoding="utf-8")


def test_old_publisher_with_current_frontend_exits_with_that_cell(tmp_path: Path) -> None:
    manifest = _load()

    def execute(request: nightly_matrix.CommandRequest) -> int:
        if request.cell == "new-frontend-old-publisher" and request.tree == "publisher":
            return 4
        return 0

    code, seen = _round(manifest, tmp_path, execute, repo=ROOT)

    assert code == 4
    assert seen == [manifest["frontend"]["new"], manifest["publisher"]["old"]]
    saved = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    cells = json.loads((tmp_path / "cells.json").read_text(encoding="utf-8"))
    sides = {side["tree"]: side["sha"] for side in cells[0]["sides"]}
    assert cells[0]["label"] == "新 Frontend + 旧 Publisher"
    assert cells[0]["exit_code"] == 4
    assert sides["frontend"] == saved["frontend"]["new"] == manifest["frontend"]["new"]
    assert sides["publisher"] == saved["publisher"]["old"] == manifest["publisher"]["old"]
    assert "失败 owner: novelcomic-platform" in (tmp_path / "logs.txt").read_text(encoding="utf-8")
    assert "contracts.json" not in {path.name for path in tmp_path.iterdir()}


def test_one_sided_contract_is_labeled_in_repo_parse(tmp_path: Path) -> None:
    manifest = _load()

    def execute(request: nightly_matrix.CommandRequest) -> int:
        if request.name == "model-call-contracts.test.ts":
            return 0
        if request.name == "test_callback_parser.py":
            return 1
        return 0

    code, _seen = _round(manifest, tmp_path, execute)
    contracts = json.loads((tmp_path / "contracts.json").read_text(encoding="utf-8"))
    text = json.dumps(contracts, ensure_ascii=False)

    assert code == 1
    assert contracts["verdict"] == "仓内解析通过"
    assert "model-call-contracts.test.ts" in text
    assert "test_callback_parser.py" in text
    assert "仓内解析通过" in (tmp_path / "logs.txt").read_text(encoding="utf-8")


def test_both_contract_sides_do_not_use_the_partial_label(tmp_path: Path) -> None:
    manifest = _load()
    code, _seen = _round(manifest, tmp_path, lambda _request: 0)
    contracts = json.loads((tmp_path / "contracts.json").read_text(encoding="utf-8"))
    commands = (tmp_path / "commands.txt").read_text(encoding="utf-8")

    assert code == 0
    assert contracts["verdict"] == "两边解析通过"
    assert "仓内解析通过" not in (tmp_path / "logs.txt").read_text(encoding="utf-8")
    assert "创建 run，收到 SSE，走完一条 HITL" in commands
    assert len(json.loads((tmp_path / "cells.json").read_text(encoding="utf-8"))) == 7


def test_external_model_step_is_outside_the_seven_cells(tmp_path: Path) -> None:
    manifest = _load()
    kinds: list[str] = []

    def execute(request: nightly_matrix.CommandRequest) -> int:
        kinds.append(request.kind)
        return 0

    code = nightly_matrix.run_external(
        manifest,
        tmp_path,
        execute=execute,
        checkout=lambda sha: tmp_path / sha,
    )
    logs = (tmp_path / "logs.txt").read_text(encoding="utf-8")
    commands = (tmp_path / "commands.txt").read_text(encoding="utf-8")

    assert code == 0
    assert kinds == ["external", "external"]
    assert "外部模型 test:kling-*" in logs
    assert "外部模型 run_real_opencreator_ai_e2e.py" in logs
    assert "新 Frontend + 旧 Publisher" not in commands
    assert len(nightly_matrix.MATRIX_CELLS) == 7
    assert all(cell.name != "external-models" for cell in nightly_matrix.MATRIX_CELLS)


def test_config_summary_redacts_secrets(tmp_path: Path) -> None:
    secret = "super-secret-value"
    code, _seen = _round(
        _load(),
        tmp_path,
        lambda _request: 0,
        env={
            "CONSUMER_WEBHOOK_SECRET": secret,
            "PUBLISHER_URL": "https://publisher.example",
        },
    )
    summary = json.loads((tmp_path / "config-summary.json").read_text(encoding="utf-8"))
    blob = "\n".join(
        path.read_text(encoding="utf-8") for path in tmp_path.iterdir() if path.is_file()
    )

    assert code == 0
    assert summary["CONSUMER_WEBHOOK_SECRET"] == "***"
    assert summary["PUBLISHER_URL"] == "https://publisher.example"
    assert secret not in blob


def test_workflow_runs_manifest_cells_then_external_models() -> None:
    text = WORKFLOW_PATH.read_text(encoding="utf-8")
    assert text.index("nightly_matrix.py validate") < text.index("nightly_matrix.py run")
    assert text.index("nightly_matrix.py run") < text.index("nightly_matrix.py external")
    assert "revision-manifest.json" in text
    assert "actions/upload-artifact@v4" in text
    assert "if: always()" in text
    assert "continue-on-error" not in text
    assert "github.sha" not in text
    assert "cron:" in text


def test_validate_cli_accepts_the_checked_in_manifest() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "nightly_matrix.py"),
            "validate",
            "--manifest",
            str(MANIFEST_PATH),
            "--repo",
            str(ROOT),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert "revision manifest" in result.stdout
