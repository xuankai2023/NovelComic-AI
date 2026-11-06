from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol


class ModelProviderRequestLike(Protocol):
    model_id: str
    arguments: Mapping[str, Any] | None
    model_options: Mapping[str, Any] | None


class OpenCreatorAIOptionsBuilder:
    FIELD_ALIASES: dict[str, tuple[str, ...]] = {
        "negative_prompt": ("negativePrompt", "negativePromptText"),
        "aspect_ratio": ("aspectRatio", "ratio"),
        "size": ("imageSize", "outputSize"),
    }
    PROMPT_KEYS = ("prompt", "text", "input", "input_text", "description")

    @classmethod
    def build(cls, request: ModelProviderRequestLike) -> dict[str, Any]:
        options: dict[str, Any] = {}
        options.update(cls._coerce_mapping(request.arguments))
        options.update(cls._model_options_for_request(request))
        cls._normalize_schema_fields(options)

        return {
            key: value
            for key, value in options.items()
            if value is not None
        }

    @classmethod
    def _model_options_for_request(
        cls,
        request: ModelProviderRequestLike,
    ) -> dict[str, Any]:
        model_options = cls._coerce_mapping(request.model_options)
        model_specific = model_options.get(request.model_id)
        if isinstance(model_specific, Mapping):
            return cls._coerce_mapping(model_specific)
        return model_options

    @classmethod
    def _normalize_schema_fields(cls, options: dict[str, Any]) -> None:
        for schema_field, aliases in cls.FIELD_ALIASES.items():
            if options.get(schema_field) is not None:
                continue
            for alias in aliases:
                if options.get(alias) is not None:
                    options[schema_field] = options[alias]
                    break

        if options.get("prompt") is None:
            prompt = cls._extract_prompt(options)
            if prompt is not None:
                options["prompt"] = prompt

    @classmethod
    def _extract_prompt(cls, options: Mapping[str, Any]) -> Any:
        for key in cls.PROMPT_KEYS:
            value = options.get(key)
            if value is not None:
                return value

        node = options.get("node")
        if isinstance(node, Mapping):
            node_data = node.get("data") if isinstance(node.get("data"), Mapping) else node
            for key in cls.PROMPT_KEYS:
                value = node_data.get(key)
                if value is not None:
                    return value

        inputs = options.get("inputs")
        if isinstance(inputs, Mapping):
            for key in cls.PROMPT_KEYS:
                value = inputs.get(key)
                if value is not None:
                    return value

        return None

    @staticmethod
    def _coerce_mapping(value: Mapping[str, Any] | None) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            return {}
        return dict(value)
