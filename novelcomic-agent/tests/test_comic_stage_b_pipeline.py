"""Ten-page L0 production reaches a playable delivery, including one missed line."""

from __future__ import annotations

import ast
import hashlib
from pathlib import Path

from novelcomic_agent.comic.persistence.memory import MemoryLedger
from novelcomic_agent.comic.storage.object_store import MemoryObjectStore
from novelcomic_agent.comic.wiring import build_stage_b
from novelcomic_agent.comic.workflow.production_states import ProductionState
from tests.comic_support import (
    MemoryFetcher,
    ScriptedDetector,
    ScriptedRemotion,
    ScriptedSpeech,
    page_png,
    production_request,
    tenant_from_header,
)

ROOT = Path(__file__).resolve().parents[1]
GUARDED = (
    "src/novelcomic_agent/main.py",
    "src/novelcomic_agent/comic/runtime.py",
    "src/novelcomic_agent/comic/api/agent_auth.py",
    "src/novelcomic_agent/comic/api/product_routes.py",
    "src/novelcomic_agent/comic/queue/outbox_publisher.py",
    "src/novelcomic_agent/comic/queue/worker_consumer.py",
    "src/novelcomic_agent/comic/queue/rabbit_broker.py",
    "src/novelcomic_agent/comic/workers/analyze_worker.py",
    "src/novelcomic_agent/comic/workers/voice_worker.py",
    "src/novelcomic_agent/comic/workers/render_worker.py",
    "src/novelcomic_agent/comic/assets/l0_panel.py",
    "src/novelcomic_agent/comic/wiring.py",
)
FORBIDDEN = (
    "l1_layer_service",
    "l2_sprite_service",
    "asset_worker",
    "preview_worker",
    "package_worker",
    "comic.qa",
    "comic.delivery",
)


async def test_ten_pages_deliver_when_one_line_fails() -> None:
    pages = [(f"https://cdn.example/page-{index}.png", index) for index in range(1, 11)]
    images = {url: page_png(f"page-body-{number}") for url, number in pages}
    remotion = ScriptedRemotion()
    speech = ScriptedSpeech()
    runtime = build_stage_b(
        ledger=MemoryLedger(),
        remotion=remotion,
        objects=MemoryObjectStore(),
        detector=ScriptedDetector(fail_image=images["https://cdn.example/page-3.png"]),
        speech=speech,
        fetcher=MemoryFetcher(images),
        allowed_hosts=frozenset({"cdn.example", "objects.novelcomic.local"}),
        authenticate=tenant_from_header,
    )
    accepted = await runtime.service.accept("tenant-a", production_request(pages, request_id="ten"))
    await runtime.analyze.run(accepted.production_id)
    await runtime.voice.run(accepted.production_id)
    snapshot = await runtime.render.run(accepted.production_id)

    assert snapshot.state is ProductionState.DELIVERED
    row = await runtime.productions.get_row(accepted.production_id)
    assert row.degraded is True
    assert row.can_produce_playable is True
    missing = row.stage_facts["SYNTHESIZING_VOICE"]["missingLines"]
    assert len(missing) == 1
    assert row.stage_facts["PREPARING_ASSETS"]["panelFitApplied"] is False
    assert row.stage_facts["COMPOSING"]["panelFitApplied"] is True
    assert any(
        name == "image/sequence" and payload.get("panelFitPolicy") == "blurred-background-contain"
        for name, payload in remotion.payloads
    )
    assert any(
        name == "image/sequence" and payload.get("fitAlgorithmVersion") == "contain-blur-v1"
        for name, payload in remotion.payloads
    )
    assert any(
        shot_from > 0 and line_from > shot_from
        for shot_from, line_from in remotion.dialogue_checks
    )

    deliveries = await runtime.service.deliveries("tenant-a", accepted.production_id)
    assert len(deliveries["deliveries"]) == 1
    item = deliveries["deliveries"][0]
    assert item["checksum"] == hashlib.sha256(b"mp4-bytes").hexdigest()
    assert item["url"].startswith("https://signed.novelcomic.local/")
    assert await runtime.objects.get(item["objectKey"]) == b"mp4-bytes"
    assert speech.calls == 10


def test_panel_fit_is_applied_only_when_both_layers_are_committed() -> None:
    from novelcomic_agent.comic.assets.l0_panel import committed_panel_fit_applied

    shot_id = "shot-1"
    project = {
        "assets": {"asset:shot-1:panel": {"id": "asset:shot-1:panel"}},
        "items": {
            "item:shot-1:panel-foreground": {
                "id": "item:shot-1:panel-foreground",
                "assetId": "asset:shot-1:panel",
                "fit": "contain",
                "role": "panel-foreground",
            },
            "item:shot-1:panel-background": {
                "id": "item:shot-1:panel-background",
                "assetId": "asset:shot-1:panel",
                "fit": "cover",
                "role": "panel-background",
                "blurRadiusPx": 28,
                "dimOpacity": 0.45,
            },
        },
        "tracks": [
            {
                "id": "track:shot-1:panel-foreground",
                "items": ["item:shot-1:panel-foreground"],
                "hidden": False,
            },
            {
                "id": "track:shot-1:panel-background",
                "items": ["item:shot-1:panel-background"],
                "hidden": False,
            },
        ],
    }
    assert committed_panel_fit_applied(project, [shot_id]) is True
    swapped = {
        **project,
        "tracks": list(reversed(project["tracks"])),
    }
    assert committed_panel_fit_applied(swapped, [shot_id]) is False
    missing = {
        **project,
        "items": {
            "item:shot-1:panel-foreground": project["items"]["item:shot-1:panel-foreground"]
        },
    }
    assert committed_panel_fit_applied(missing, [shot_id]) is False


def test_stage_b_does_not_import_later_stages() -> None:
    for relative in GUARDED:
        tree = ast.parse((ROOT / relative).read_text())
        imported: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.append(node.module)
                imported.extend(alias.name for alias in node.names)
        text = " ".join(imported)
        assert not any(name in text for name in FORBIDDEN)
