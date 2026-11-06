"""删除门禁：调用方还在、阶段没走完、或 manifest 缺键时不能删。"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import legacy_compat_retirement as retirement

MANIFEST = json.loads((ROOT / "revision-manifest.json").read_text(encoding="utf-8"))


def test_entries_record_label_callers_and_deletion_condition() -> None:
    for entry_id in ("v1_flow", "legacy_agent_chat", "legacy_model_id", "payments_deprecated"):
        entry = retirement.ENTRIES[entry_id]
        assert entry.label
        assert entry.callers
        assert entry.deletion_condition
    assert retirement.ENTRIES["v1_flow"].volume_key == "v1_flow"
    assert retirement.ENTRIES["legacy_agent_chat"].volume_key == "legacy_agent_chat"
    assert retirement.ENTRIES["legacy_model_id"].volume_key == "legacy_model_id"


def test_config_dump_writes_switches_and_omits_secrets() -> None:
    dumped = retirement.config_dump(
        {
            "ENABLE_BULL_BOARD": True,
            "memory_enabled": False,
            "AUTH_KEY": "super-secret",
            "CONSUMER_WEBHOOK_SECRET": "whsec",
            "clerk_pem_public_key": "pem",
            "posthog_api_key": "ph_live",
        }
    )
    assert dumped["ENABLE_BULL_BOARD"] is True
    assert dumped["CONFIG_LOADER_ENABLED"] is False
    assert dumped["ALERT_FEISHU_ENABLED"] is False
    assert dumped["MODEL_CALL_FEISHU_ENABLED"] is False
    assert dumped["memory_enabled"] is False
    text = json.dumps(dumped)
    assert "super-secret" not in text
    assert "whsec" not in text
    assert "ph_live" not in text
    assert "AUTH_KEY" not in dumped


def test_delete_follows_stop_write_then_read_then_fallback() -> None:
    progress: list[str] = []
    try:
        retirement.advance(progress, "remove_fallback")
        raise AssertionError("skipped stages")
    except retirement.CompatRetirementError:
        pass
    progress = retirement.advance(progress, "stop_write")
    progress = retirement.advance(progress, "change_read")
    progress = retirement.advance(progress, "remove_fallback")
    try:
        retirement.plan_delete("legacy_agent_chat", volume=2, progress=progress)
        raise AssertionError("volume still present")
    except retirement.CompatRetirementError as error:
        assert "调用量" in str(error)
    deleted = retirement.plan_delete("legacy_agent_chat", volume=0, progress=progress)
    assert deleted["deleted"] is True
    assert deleted["sides"] is None


def test_cross_repo_delete_uses_one_manifest() -> None:
    progress = ["stop_write", "change_read", "remove_fallback"]
    try:
        retirement.plan_delete("v1_flow", volume=0, progress=progress, manifest=None)
        raise AssertionError("missing manifest")
    except retirement.CompatRetirementError as error:
        assert "revision manifest" in str(error)
    partial = {"publisher": MANIFEST["publisher"]}
    try:
        retirement.plan_delete("v1_flow", volume=0, progress=progress, manifest=partial)
        raise AssertionError("consumer sha missing")
    except retirement.CompatRetirementError as error:
        assert "consumer" in str(error)
    deleted = retirement.plan_delete("v1_flow", volume=0, progress=progress, manifest=MANIFEST)
    sides = deleted["sides"]
    assert isinstance(sides, dict)
    assert sides["producer"]["sha"] == MANIFEST["publisher"]["new"]
    assert sides["consumer"]["sha"] == MANIFEST["consumer"]["new"]


def test_deprecated_payments_stay_while_callers_exist() -> None:
    source = "async def save_payments(cls, payments):\n    return payments\n"
    kept = retirement.plan_delete(
        "payments_deprecated",
        live_callers=["billing.py"],
        source=source,
    )
    assert kept["deleted"] is False
    assert kept["source"] == source
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        definition = root / "dao" / "payments.py"
        definition.parent.mkdir()
        definition.write_text("    async def save_payments(cls, payments):\n        return payments\n", encoding="utf-8")
        caller = root / "services" / "billing.py"
        caller.parent.mkdir()
        caller.write_text("await PaymentsDao.save_payments(payments)\n", encoding="utf-8")
        assert retirement.find_python_callers(root, "save_payments", definition) == ["services/billing.py"]
        caller.unlink()
        assert retirement.find_python_callers(root, "save_payments", definition) == []
        removed = retirement.plan_delete(
            "payments_deprecated",
            live_callers=[],
            progress=["stop_write", "change_read", "remove_fallback"],
            source=source,
        )
        assert removed["deleted"] is True


def main() -> None:
    test_entries_record_label_callers_and_deletion_condition()
    test_config_dump_writes_switches_and_omits_secrets()
    test_delete_follows_stop_write_then_read_then_fallback()
    test_cross_repo_delete_uses_one_manifest()
    test_deprecated_payments_stay_while_callers_exist()
    print("legacy compat retirement ok")


if __name__ == "__main__":
    main()
