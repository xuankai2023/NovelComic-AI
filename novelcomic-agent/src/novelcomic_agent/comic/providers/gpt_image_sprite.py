"""L2 eye/mouth sprite provider via OpenCreator GPT Image 2 edit route.

Uses the same Baidu → Tencent client as L1. Missing states are reported, never
invented. ``reconcile`` only returns generations already accepted in-process.
"""

from __future__ import annotations

import logging

from novelcomic_agent.config import Settings

from ..assets.l2_sprite_service import (
    ProviderSpriteState,
    SpriteGeneration,
    SpriteProviderError,
)
from .gpt_image_2 import GptImage2Client, GptImage2Error, GptImage2Settings

logger = logging.getLogger(__name__)

_KNOWN = frozenset(
    {
        "eye:open",
        "eye:closed",
        "mouth:closed",
        "mouth:open",
        "mouth:half",
    }
)

_PROMPTS = {
    "eye:open": (
        "Edit this comic character close-up so both eyes are clearly open and "
        "looking forward. Keep identity, line art, colors, framing, and "
        "background. Return a PNG suitable as an eye overlay."
    ),
    "eye:closed": (
        "Edit this comic character close-up so both eyes are gently closed "
        "(blink). Keep identity, line art, colors, framing, and background. "
        "Return a PNG suitable as an eye overlay."
    ),
    "mouth:closed": (
        "Edit this comic character close-up so the mouth is closed and neutral. "
        "Keep identity, line art, colors, framing, and background. Return a PNG "
        "suitable as a mouth overlay."
    ),
    "mouth:open": (
        "Edit this comic character close-up so the mouth is open as if speaking. "
        "Keep identity, line art, colors, framing, and background. Return a PNG "
        "suitable as a mouth overlay."
    ),
    "mouth:half": (
        "Edit this comic character close-up so the mouth is half-open mid speech. "
        "Keep identity, line art, colors, framing, and background. Return a PNG "
        "suitable as a mouth overlay."
    ),
}


class GptImageSpriteProvider:
    """Generate required eye/mouth state images with GPT Image 2 edit."""

    def __init__(
        self,
        *,
        client: GptImage2Client,
        unit_price_fen: int = 0,
    ) -> None:
        if (
            isinstance(unit_price_fen, bool)
            or not isinstance(unit_price_fen, int)
            or unit_price_fen < 0
        ):
            raise ValueError("COMIC_SPRITE_UNIT_PRICE_FEN must be a non-negative integer")
        self._client = client
        self._unit_price_fen = unit_price_fen
        self._accepted: dict[str, SpriteGeneration] = {}

    @classmethod
    def from_settings(cls, settings: Settings) -> GptImageSpriteProvider | None:
        gpt = GptImage2Settings.from_env()
        if not (gpt.baidu_api_key or gpt.tencent_api_key):
            return None
        unit = int(getattr(settings, "comic_sprite_unit_price_fen", 0) or 0)
        return cls(client=GptImage2Client(gpt), unit_price_fen=unit)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def generate(
        self,
        *,
        request_id: str,
        shot_id: str,
        source_url: str,
        canvas_width: int,
        canvas_height: int,
        model_version: str,
        parameter_version: str,
        required_states: tuple[str, ...],
    ) -> SpriteGeneration:
        del shot_id, canvas_width, canvas_height, model_version, parameter_version
        if request_id in self._accepted:
            return self._accepted[request_id]
        if not source_url.strip():
            raise SpriteProviderError("sprite-source-missing", permanent=True)

        states: list[ProviderSpriteState] = []
        missing: list[str] = []
        warnings: list[str] = []
        paid = 0

        for key in required_states:
            if key not in _KNOWN:
                missing.append(key)
                continue
            prompt = _PROMPTS[key]
            try:
                edited = await self._client.edit(
                    prompt=prompt,
                    image_url=source_url,
                    quality="medium",
                )
            except GptImage2Error as exc:
                logger.warning("L2 sprite %s failed for %s: %s", key, request_id, exc)
                missing.append(key)
                warnings.append(f"{key}:provider-failed")
                if not exc.retryable and not states and key == required_states[0]:
                    # First required state permanently failed with no output.
                    if "required" in str(exc).lower() and "key" in str(exc).lower():
                        raise SpriteProviderError("sprite-provider-unconfigured", permanent=True) from exc
                continue
            part, semantic = key.split(":", 1)
            states.append(ProviderSpriteState(part, semantic, edited.image))
            paid += self._unit_price_fen

        if not states and missing == list(required_states):
            raise SpriteProviderError("sprite-all-states-failed", permanent=False)

        result = SpriteGeneration(
            provider_request_id=request_id,
            cost_fen=paid,
            states=tuple(states),
            missing=tuple(missing),
            warnings=tuple(dict.fromkeys(warnings)),
        )
        self._accepted[request_id] = result
        return result

    async def reconcile(self, request_id: str) -> SpriteGeneration | None:
        return self._accepted.get(request_id)
