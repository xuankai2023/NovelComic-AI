from __future__ import annotations

from typing import Any

from app.services.opencreator_ai.legacy_call_volume import note_legacy_model_id

KIE_IMAGE_MODEL_ID = "kie-image-v1"

LEGACY_TO_OPENCREATOR_MODEL_ID: dict[str, str] = {
    KIE_IMAGE_MODEL_ID: KIE_IMAGE_MODEL_ID,
    "kie-image": KIE_IMAGE_MODEL_ID,
    "z-image": KIE_IMAGE_MODEL_ID,
    "gpt-image-2": "opencreator/text-to-image/gpt-image-2",
    "gpt-image-2-edit": "opencreator/image-to-image/gpt-image-2-edit",
    "openai/gpt-image-2": "opencreator/text-to-image/gpt-image-2",
    "openai/gpt-image-2/edit": "opencreator/image-to-image/gpt-image-2-edit",
    "midjourney": "opencreator/text-to-image/midjourney-v7",
    "midjourney-v7": "opencreator/text-to-image/midjourney-v7",
    "midjourney/v7/text-to-image": "opencreator/text-to-image/midjourney-v7",
    "midjourney/v7/image-to-image": "opencreator/image-to-image/midjourney-v7",
    "flux-pro-1.1": "opencreator/text-to-image/flux-pro-1.1",
    "flux-kontext-pro": "opencreator/image-to-image/flux-kontext-pro",
    "seedance-2.0-fast": "opencreator/text-to-video/seedance-2.0-fast",
    "seedance-2.0": "opencreator/text-to-video/seedance-2.0",
    "kling-v2-master": "opencreator/text-to-video/kling-v2-master",
    "wan-2.6": "opencreator/text-to-video/wan-2.6",
    "vidu-q1": "opencreator/text-to-video/vidu-q1",
    "hailuo-02": "opencreator/text-to-video/hailuo-02",
    "veo-3": "opencreator/text-to-video/veo-3",
    "sora-2": "opencreator/text-to-video/sora-2",
    "elevenlabs-tts": "opencreator/text-to-speech/elevenlabs-tts",
    "suno-v4": "opencreator/music/suno-v4",
    "gpt-4o-mini": "opencreator/text/gpt-4o-mini",
    "gpt-4o": "opencreator/text/gpt-4o",
    "claude-3-7-sonnet": "opencreator/text/claude-3-7-sonnet",
    "deepseek-v3": "opencreator/text/deepseek-v3",
}

CONFIG_SCOPED_LEGACY_TO_OPENCREATOR_MODEL_ID: dict[str, dict[str, str]] = {
    "imageModel": {
        "default": KIE_IMAGE_MODEL_ID,
    },
    "image_model": {
        "default": KIE_IMAGE_MODEL_ID,
    },
    "imageMaker": {
        "default": KIE_IMAGE_MODEL_ID,
        "gpt-image-2": "opencreator/text-to-image/gpt-image-2",
        "midjourney": "opencreator/text-to-image/midjourney-v7",
    },
    "imageToImage": {
        "default": "opencreator/image-to-image/gpt-image-2-edit",
        "gpt-image-2": "opencreator/image-to-image/gpt-image-2-edit",
        "midjourney": "opencreator/image-to-image/midjourney-v7",
    },
    "text_to_image_config": {
        "default": KIE_IMAGE_MODEL_ID,
    },
    "videoMaker": {
        "default": "opencreator/text-to-video/seedance-2.0-fast",
    },
    "textToVideo": {
        "default": "opencreator/text-to-video/seedance-2.0-fast",
    },
    "textGenerator": {
        "default": "opencreator/text/gpt-4o-mini",
    },
    "textToSpeech": {
        "default": "opencreator/text-to-speech/elevenlabs-tts",
    },
}


class MissingOpenCreatorAIModelMapping(ValueError):
    def __init__(self, *, model_id: str, config_name: str = "") -> None:
        message = f"Missing OpenCreator AI model mapping for {model_id!r}"
        if config_name:
            message = f"{message} in config {config_name!r}"
        super().__init__(message)
        self.model_id = model_id
        self.config_name = config_name


class OpenCreatorAIModelMapper:
    @classmethod
    def mapping_report(cls) -> dict[str, Any]:
        scoped_count = sum(
            len(models) for models in CONFIG_SCOPED_LEGACY_TO_OPENCREATOR_MODEL_ID.values()
        )
        return {
            "mapped_count": len(LEGACY_TO_OPENCREATOR_MODEL_ID) + scoped_count,
            "models": dict(LEGACY_TO_OPENCREATOR_MODEL_ID),
            "scoped_models": {
                config_name: dict(models)
                for config_name, models in CONFIG_SCOPED_LEGACY_TO_OPENCREATOR_MODEL_ID.items()
            },
        }

    @classmethod
    def to_opencreator_model_id(cls, model_id: str, config_name: str = "") -> str:
        normalized_model_id = model_id.strip()
        normalized_config_name = config_name.strip()

        if not normalized_model_id:
            raise MissingOpenCreatorAIModelMapping(
                model_id=model_id,
                config_name=normalized_config_name,
            )

        scoped = CONFIG_SCOPED_LEGACY_TO_OPENCREATOR_MODEL_ID.get(
            normalized_config_name,
            {},
        ).get(normalized_model_id)
        if scoped:
            note_legacy_model_id()
            return scoped

        mapped = LEGACY_TO_OPENCREATOR_MODEL_ID.get(normalized_model_id)
        if mapped:
            note_legacy_model_id()
            return mapped

        if normalized_model_id.startswith("opencreator/"):
            return normalized_model_id

        raise MissingOpenCreatorAIModelMapping(
            model_id=normalized_model_id,
            config_name=normalized_config_name,
        )
