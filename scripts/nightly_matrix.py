#!/usr/bin/env python3
"""按 revision-manifest.json 跑夜间七格，并把产物写到同一轮目录。

同一个 git 仓库里，一个 SHA 锁住同一次提交的五份树。新 Frontend 配旧 Publisher
时，两格各做一个 worktree。缺键、或清单写成默认分支 HEAD，在跑测试之前失败。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

REQUIRED_KEYS = ("frontend", "publisher", "consumer", "ai", "agent", "tests", "owner")
TREE_ROLES = {
    "frontend": ("new", "old"),
    "publisher": ("new", "old"),
    "consumer": ("new", "old"),
    "ai": ("new", "old"),
    "agent": ("new",),
}
PARTIAL_CONTRACT = "仓内解析通过"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SECRET_MARKERS = ("SECRET", "TOKEN", "PASSWORD", "KEY", "DSN", "CREDENTIAL", "COOKIE")
PLAIN_MARKERS = ("URL", "HOST", "ENV", "SLOT", "PORT")


@dataclass(frozen=True)
class Side:
    tree: str
    role: str


@dataclass(frozen=True)
class Cell:
    name: str
    label: str
    sides: tuple[Side, ...]
    run_trees: tuple[str, ...]
    scenario: str = ""


@dataclass(frozen=True)
class CommandRequest:
    kind: str
    cell: str
    tree: str
    role: str
    sha: str
    cwd: str
    command: str
    name: str = ""


MATRIX_CELLS = (
    Cell(
        "new-frontend-old-publisher",
        "新 Frontend + 旧 Publisher",
        (Side("frontend", "new"), Side("publisher", "old")),
        ("frontend", "publisher"),
    ),
    Cell(
        "old-frontend-new-publisher",
        "旧 Frontend + 新 Publisher",
        (Side("frontend", "old"), Side("publisher", "new")),
        ("frontend", "publisher"),
    ),
    Cell(
        "new-publisher-old-consumer",
        "新 Publisher + 旧 Consumer",
        (Side("publisher", "new"), Side("consumer", "old")),
        ("publisher", "consumer"),
    ),
    Cell(
        "old-publisher-new-consumer",
        "旧 Publisher + 新 Consumer",
        (Side("publisher", "old"), Side("consumer", "new")),
        ("publisher", "consumer"),
    ),
    Cell(
        "new-ai-old-consumer",
        "新 AI + 旧 Consumer",
        (Side("ai", "new"), Side("consumer", "old")),
        ("ai", "consumer"),
    ),
    Cell(
        "old-ai-new-consumer",
        "旧 AI + 新 Consumer",
        (Side("ai", "old"), Side("consumer", "new")),
        ("ai", "consumer"),
    ),
    Cell(
        "new-agent-publisher-consumer",
        "新 Agent + manifest 中的 Publisher 与 Consumer",
        (Side("agent", "new"), Side("publisher", "new"), Side("consumer", "new")),
        ("agent",),
        "创建 run，收到 SSE，走完一条 HITL",
    ),
)


def load_manifest(path: Path) -> dict[str, object]:
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise TypeError("revision manifest 不是对象")
    return loaded


def default_branch_head(repo: Path) -> str:
    symbolic = subprocess.run(
        ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    ref = "main"
    if symbolic.returncode == 0 and symbolic.stdout.strip():
        ref = symbolic.stdout.strip()
    rev = subprocess.run(
        ["git", "rev-parse", ref],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    return rev.stdout.strip()


def structure_errors(manifest: object) -> list[str]:
    if not isinstance(manifest, dict):
        return ["revision manifest 不是对象"]
    errors: list[str] = []
    for key in REQUIRED_KEYS:
        if key not in manifest:
            errors.append(f"缺少键 {key}")
    if errors:
        return errors
    for tree, roles in TREE_ROLES.items():
        entry = manifest[tree]
        if not isinstance(entry, dict):
            errors.append(f"{tree} 不是 commit 对象")
            continue
        for role in roles:
            sha = entry.get(role)
            if isinstance(sha, str) and sha.strip().upper() == "HEAD":
                errors.append(f"{tree}.{role} 写成了 HEAD")
            elif not isinstance(sha, str) or SHA_RE.fullmatch(sha) is None:
                errors.append(f"缺少 {tree}.{role} 的完整 commit")
    owner = manifest["owner"]
    if not isinstance(owner, str) or not owner.strip():
        errors.append("owner 为空")
    tests = manifest["tests"]
    if not isinstance(tests, dict):
        errors.append("tests 不是本轮命令")
        return errors
    for tree in ("frontend", "publisher", "consumer", "ai", "agent"):
        spec = tests.get(tree)
        if not isinstance(spec, dict) or not spec.get("cwd") or not spec.get("commands"):
            errors.append(f"tests.{tree} 缺少 cwd 或 commands")
    contracts = tests.get("contracts")
    if not isinstance(contracts, dict):
        errors.append("tests.contracts 缺少 AI 与 Consumer 两边")
    else:
        for side in ("ai", "consumer"):
            item = contracts.get(side)
            if not _complete_command(item):
                errors.append(f"tests.contracts.{side} 不完整")
    external = tests.get("external")
    if not isinstance(external, list) or not external:
        errors.append("tests.external 缺少外部模型命令")
    else:
        for item in external:
            if not _complete_command(item):
                errors.append("tests.external 有一条命令不完整")
    return errors


def pin_errors(manifest: Mapping[str, object], repo: Path) -> list[str]:
    errors: list[str] = []
    try:
        head = default_branch_head(repo)
    except subprocess.CalledProcessError as exc:
        return [f"读不到默认分支 HEAD: {exc}"]
    for label, sha in _labeled_commits(manifest):
        if not isinstance(sha, str) or SHA_RE.fullmatch(sha) is None:
            continue
        if sha == head:
            errors.append(f"{label} 使用了默认分支 HEAD")
        probe = subprocess.run(
            ["git", "cat-file", "-t", sha],
            cwd=repo,
            capture_output=True,
            text=True,
            check=False,
        )
        if probe.returncode != 0 or probe.stdout.strip() != "commit":
            errors.append(f"{label} {sha} 不是 commit")
    return errors


def validate_manifest(manifest: Mapping[str, object], repo: Path | None = None) -> list[str]:
    errors = structure_errors(manifest)
    if repo is not None:
        errors.extend(pin_errors(manifest, repo))
    return errors


def _complete_command(item: object) -> bool:
    if not isinstance(item, dict):
        return False
    return bool(item.get("name") and item.get("command") and item.get("cwd"))


def contract_verdict(ai_code: int, consumer_code: int) -> str:
    if ai_code == 0 and consumer_code == 0:
        return "两边解析通过"
    if ai_code == 0 or consumer_code == 0:
        return PARTIAL_CONTRACT
    return "两边解析失败"


def redact_config(env: Mapping[str, str]) -> dict[str, str]:
    summary: dict[str, str] = {}
    for key in sorted(env):
        upper = key.upper()
        if any(marker in upper for marker in SECRET_MARKERS):
            summary[key] = "***"
        elif any(marker in upper for marker in PLAIN_MARKERS):
            summary[key] = env[key]
    return summary


def execute_round(
    manifest: Mapping[str, object],
    *,
    artifact_dir: Path,
    repo: Path | None = None,
    execute: Callable[[CommandRequest], int] | None = None,
    checkout: Callable[[str], Path] | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
    errors = validate_manifest(manifest, repo if checkout is None else None)
    if checkout is not None and repo is not None:
        errors.extend(pin_errors(manifest, repo))
    artifact_dir.mkdir(parents=True, exist_ok=True)
    if errors:
        _write_artifacts(
            artifact_dir,
            manifest,
            env or {},
            commands=[],
            logs=["夜间 job 在跑测试之前失败", *errors],
            cells=[],
            contracts=None,
            failed=True,
        )
        return 1

    if checkout is None or execute is None:
        if repo is None:
            raise RuntimeError("真实跑矩阵需要 git 仓库")
        with tempfile.TemporaryDirectory(prefix="nightly-wt-") as tmp:
            return _execute_in_worktrees(
                manifest,
                repo=repo,
                work_root=Path(tmp),
                artifact_dir=artifact_dir,
                env=env or {},
            )

    runner = execute
    checkout_sha = checkout
    commands: list[str] = []
    logs: list[str] = []
    cells: list[dict[str, object]] = []
    cell_code = 0
    for cell in MATRIX_CELLS:
        code, cell_body = _run_cell(manifest, cell, checkout_sha, runner, commands, logs)
        cells.append(cell_body)
        if code != 0:
            cell_code = code
            break
    contracts: dict[str, object] | None = None
    contract_code = 0
    if cell_code == 0:
        contract_code, contracts = _run_contracts(manifest, checkout_sha, runner, commands, logs)
    exit_code = cell_code or contract_code
    _write_artifacts(
        artifact_dir,
        manifest,
        env or {},
        commands,
        logs,
        cells,
        contracts,
        failed=exit_code != 0,
    )
    return exit_code


def run_external(
    manifest: Mapping[str, object],
    artifact_dir: Path,
    *,
    execute: Callable[[CommandRequest], int] | None = None,
    checkout: Callable[[str], Path] | None = None,
    repo: Path | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
    """单独跑外部模型。这一步不进入七格。"""
    errors = validate_manifest(manifest, repo)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    if errors:
        _append_lines(artifact_dir / "logs.txt", ["外部模型步骤在跑命令之前失败", *errors])
        return 1
    if execute is None or checkout is None:
        if repo is None:
            raise RuntimeError("真实跑外部模型需要 git 仓库")
        with tempfile.TemporaryDirectory(prefix="nightly-ext-") as tmp:
            created: list[Path] = []

            def real_checkout(sha: str) -> Path:
                return _git_worktree(repo, sha, Path(tmp), created)

            try:
                return _run_external_commands(
                    manifest,
                    artifact_dir,
                    real_checkout,
                    _subprocess_in(real_checkout),
                    env or {},
                )
            finally:
                _remove_worktrees(repo, created)

    return _run_external_commands(manifest, artifact_dir, checkout, execute, env or {})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="夜间跨仓矩阵")
    parser.add_argument("command", choices=("validate", "run", "external"))
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--artifact-dir", type=Path, default=None)
    parser.add_argument("--repo", type=Path, default=None)
    args = parser.parse_args(argv)
    repo = (args.repo or Path.cwd()).resolve()
    manifest_path = args.manifest or (repo / "revision-manifest.json")
    artifact_dir = args.artifact_dir or (repo / "nightly-artifacts")
    manifest = load_manifest(manifest_path)
    if args.command == "validate":
        errors = validate_manifest(manifest, repo)
        if errors:
            print("\n".join(errors))
            return 1
        print("revision manifest 可用来跑夜间矩阵")
        return 0
    if args.command == "run":
        return execute_round(manifest, artifact_dir=artifact_dir, repo=repo)
    return run_external(manifest, artifact_dir, repo=repo)


def _execute_in_worktrees(
    manifest: Mapping[str, object],
    *,
    repo: Path,
    work_root: Path,
    artifact_dir: Path,
    env: Mapping[str, str],
) -> int:
    created: list[Path] = []

    def checkout(sha: str) -> Path:
        return _git_worktree(repo, sha, work_root, created)

    try:
        return execute_round(
            manifest,
            artifact_dir=artifact_dir,
            repo=repo,
            execute=_subprocess_in(checkout),
            checkout=checkout,
            env=env,
        )
    finally:
        _remove_worktrees(repo, created)


def _git_worktree(repo: Path, sha: str, work_root: Path, created: list[Path]) -> Path:
    dest = work_root / sha
    if dest.exists():
        return dest
    subprocess.run(
        ["git", "worktree", "add", "--detach", str(dest), sha],
        cwd=repo,
        check=True,
    )
    created.append(dest)
    return dest


def _remove_worktrees(repo: Path, created: list[Path]) -> None:
    for dest in created:
        subprocess.run(
            ["git", "worktree", "remove", "--force", str(dest)],
            cwd=repo,
            check=False,
        )


def _subprocess_in(checkout: Callable[[str], Path]) -> Callable[[CommandRequest], int]:
    def execute(request: CommandRequest) -> int:
        root = checkout(request.sha)
        cwd = root if request.cwd in {"", "."} else root / request.cwd
        try:
            completed = subprocess.run(request.command, cwd=cwd, shell=True, check=False)
        except FileNotFoundError:
            return 1
        return int(completed.returncode)

    return execute


def _run_external_commands(
    manifest: Mapping[str, object],
    artifact_dir: Path,
    checkout: Callable[[str], Path],
    execute: Callable[[CommandRequest], int],
    env: Mapping[str, str],
) -> int:
    tests = manifest["tests"]
    assert isinstance(tests, dict)
    external = tests["external"]
    assert isinstance(external, list)
    commands: list[str] = []
    logs: list[str] = []
    code = 0
    for item in external:
        assert isinstance(item, dict)
        name = str(item["name"])
        tree = "ai" if "kling" in name else "consumer"
        entry = manifest[tree]
        assert isinstance(entry, dict)
        sha = str(entry["new"])
        line = f"外部模型 {name}"
        logs.append(line)
        print(line)
        request = CommandRequest(
            kind="external",
            cell="external-models",
            tree=tree,
            role="new",
            sha=sha,
            cwd=str(item["cwd"]),
            command=str(item["command"]),
            name=name,
        )
        checkout(sha)
        status = execute(request)
        commands.append(f"{line} {request.command}")
        logs.append(f"{line} -> {status}")
        if status != 0 and code == 0:
            code = status
    _append_lines(artifact_dir / "commands.txt", commands)
    _append_lines(artifact_dir / "logs.txt", logs)
    if code != 0:
        owner = manifest.get("owner")
        _append_lines(artifact_dir / "logs.txt", [f"失败 owner: {owner}"])
        _write_text(artifact_dir / "owner.txt", f"{owner}\n")
    if env:
        _write_json(artifact_dir / "config-summary.json", redact_config(env))
    return code


def _run_cell(
    manifest: Mapping[str, object],
    cell: Cell,
    checkout: Callable[[str], Path],
    execute: Callable[[CommandRequest], int],
    commands: list[str],
    logs: list[str],
) -> tuple[int, dict[str, object]]:
    sides: list[dict[str, str]] = []
    cell_code = 0
    if cell.scenario:
        commands.append(cell.scenario)
        logs.append(cell.scenario)
    for side in cell.sides:
        entry = manifest[side.tree]
        assert isinstance(entry, dict)
        sha = str(entry[side.role])
        checkout(sha)
        sides.append({"tree": side.tree, "role": side.role, "sha": sha})
        if side.tree not in cell.run_trees:
            commands.append(f"{cell.label} {side.tree} {side.role} {sha} checkout")
            continue
        cwd, tree_commands = _tree_commands(manifest, side.tree)
        for command in tree_commands:
            request = CommandRequest(
                kind="cell",
                cell=cell.name,
                tree=side.tree,
                role=side.role,
                sha=sha,
                cwd=cwd,
                command=command,
            )
            status = execute(request)
            commands.append(f"{cell.label} {side.tree} {sha} {command}")
            logs.append(f"[{cell.label}] {side.tree} {sha} {command} -> {status}")
            if status != 0:
                cell_code = status
                break
        if cell_code != 0:
            break
    return cell_code, {
        "name": cell.name,
        "label": cell.label,
        "exit_code": cell_code,
        "sides": sides,
    }


def _run_contracts(
    manifest: Mapping[str, object],
    checkout: Callable[[str], Path],
    execute: Callable[[CommandRequest], int],
    commands: list[str],
    logs: list[str],
) -> tuple[int, dict[str, object]]:
    tests = manifest["tests"]
    assert isinstance(tests, dict)
    contracts = tests["contracts"]
    assert isinstance(contracts, dict)
    sides: list[dict[str, object]] = []
    codes: dict[str, int] = {}
    for tree in ("ai", "consumer"):
        item = contracts[tree]
        assert isinstance(item, dict)
        role = str(item.get("role") or "new")
        entry = manifest[tree]
        assert isinstance(entry, dict)
        sha = str(entry[role])
        checkout(sha)
        request = CommandRequest(
            kind="contract",
            cell="contracts",
            tree=tree,
            role=role,
            sha=sha,
            cwd=str(item["cwd"]),
            command=str(item["command"]),
            name=str(item["name"]),
        )
        status = execute(request)
        codes[tree] = status
        commands.append(f"{request.name} {sha} {request.command}")
        logs.append(f"[contracts] {request.name} {sha} -> {status}")
        sides.append({"name": request.name, "tree": tree, "sha": sha, "exit_code": status})
    verdict = contract_verdict(codes["ai"], codes["consumer"])
    logs.append(verdict)
    exit_code = 0 if codes["ai"] == 0 and codes["consumer"] == 0 else 1
    return exit_code, {"verdict": verdict, "sides": sides}


def _tree_commands(manifest: Mapping[str, object], tree: str) -> tuple[str, list[str]]:
    tests = manifest["tests"]
    assert isinstance(tests, dict)
    spec = tests[tree]
    assert isinstance(spec, dict)
    commands = spec["commands"]
    assert isinstance(commands, list)
    return str(spec["cwd"]), [str(command) for command in commands]


def _write_artifacts(
    artifact_dir: Path,
    manifest: Mapping[str, object],
    env: Mapping[str, str],
    commands: list[str],
    logs: list[str],
    cells: list[dict[str, object]],
    contracts: dict[str, object] | None,
    *,
    failed: bool,
) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    _write_json(artifact_dir / "manifest.json", dict(manifest))
    _write_json(artifact_dir / "config-summary.json", redact_config(env))
    _write_text(artifact_dir / "commands.txt", "\n".join(commands) + ("\n" if commands else ""))
    owner = manifest.get("owner", "")
    if failed:
        logs = [*logs, f"失败 owner: {owner}"]
    _write_text(artifact_dir / "logs.txt", "\n".join(logs) + ("\n" if logs else ""))
    _write_text(artifact_dir / "owner.txt", f"{owner}\n")
    _write_json(artifact_dir / "cells.json", cells)
    if contracts is not None:
        _write_json(artifact_dir / "contracts.json", contracts)


def _labeled_commits(manifest: Mapping[str, object]) -> list[tuple[str, object]]:
    labeled: list[tuple[str, object]] = []
    for tree, roles in TREE_ROLES.items():
        entry = manifest.get(tree)
        if not isinstance(entry, dict):
            continue
        for role in roles:
            if role in entry:
                labeled.append((f"{tree}.{role}", entry[role]))
    return labeled


def _append_lines(path: Path, lines: list[str]) -> None:
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    addition = "\n".join(lines)
    if not addition:
        return
    if existing and not existing.endswith("\n"):
        existing += "\n"
    path.write_text(existing + addition + "\n", encoding="utf-8")


def _write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
