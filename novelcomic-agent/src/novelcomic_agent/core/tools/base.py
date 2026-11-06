"""Executable tool contract shared by the agent registry."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class ToolResult:
    """Structured tool result. Registry returns this or a plain string."""

    success: bool
    content: str
    error: str | None = None


class Tool(ABC):
    """JSON-schema backed tool executed by ``ToolRegistry``."""

    _TYPE_MAP = {
        "string": str,
        "integer": int,
        "number": (int, float),
        "boolean": bool,
        "array": list,
        "object": dict,
    }

    @staticmethod
    def _resolve_type(raw_type: Any) -> str | None:
        if isinstance(raw_type, list):
            for item in raw_type:
                if item != "null":
                    return str(item)
            return None
        return raw_type if isinstance(raw_type, str) else None

    @property
    @abstractmethod
    def name(self) -> str:
        """Tool name exposed to the model."""

    @property
    @abstractmethod
    def description(self) -> str:
        """Short description exposed to the model."""

    @property
    @abstractmethod
    def parameters(self) -> dict[str, Any]:
        """JSON Schema object for the tool arguments."""

    @abstractmethod
    async def execute(self, **kwargs: Any) -> str | ToolResult:
        """Run the tool after casting and validation."""

    def cast_params(self, params: dict[str, Any]) -> dict[str, Any]:
        schema = self.parameters or {}
        if schema.get("type", "object") != "object":
            return params
        return self._cast_object(params, schema)

    def validate_params(self, params: dict[str, Any]) -> list[str]:
        if not isinstance(params, dict):
            return [f"parameters must be an object, got {type(params).__name__}"]
        schema = self.parameters or {}
        if schema.get("type", "object") != "object":
            raise ValueError(f"Schema must be object type, got {schema.get('type')!r}")
        return self._validate(params, {**schema, "type": "object"}, "")

    def to_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def _cast_object(self, obj: Any, schema: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(obj, dict):
            return obj
        properties = schema.get("properties", {})
        required = set(schema.get("required", []))
        result: dict[str, Any] = {}
        for key, value in obj.items():
            if value is None and key not in required:
                continue
            if key in properties:
                result[key] = self._cast_value(value, properties[key])
            else:
                result[key] = value
        return result

    def _cast_value(self, value: Any, schema: dict[str, Any]) -> Any:
        target_type = self._resolve_type(schema.get("type"))
        if target_type == "boolean" and isinstance(value, bool):
            return value
        if target_type == "integer" and isinstance(value, int) and not isinstance(value, bool):
            return value
        plain_types = {"boolean", "integer", "array", "object"}
        if target_type in self._TYPE_MAP and target_type not in plain_types:
            expected = self._TYPE_MAP[target_type]
            if isinstance(value, expected):
                return value
        if target_type == "integer" and isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return value
        if target_type == "number" and isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                return value
        if target_type == "string":
            return value if value is None else str(value)
        if target_type == "boolean" and isinstance(value, str):
            lowered = value.lower()
            if lowered in {"true", "1", "yes"}:
                return True
            if lowered in {"false", "0", "no"}:
                return False
            return value
        if target_type in {"array", "object"} and isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith(("[", "{")):
                try:
                    parsed = json.loads(stripped)
                except json.JSONDecodeError:
                    return value
                expected = list if target_type == "array" else dict
                if isinstance(parsed, expected):
                    value = parsed
                else:
                    return value
        if target_type == "array" and isinstance(value, list):
            item_schema = schema.get("items")
            if not item_schema:
                return value
            return [self._cast_value(item, item_schema) for item in value]
        if target_type == "object" and isinstance(value, dict):
            return self._cast_object(value, schema)
        return value

    def _validate(self, value: Any, schema: dict[str, Any], path: str) -> list[str]:
        raw_type = schema.get("type")
        nullable = bool(schema.get("nullable"))
        if isinstance(raw_type, list) and "null" in raw_type:
            nullable = True
        resolved = self._resolve_type(raw_type)
        label = path or "parameter"
        if nullable and value is None:
            return []
        if resolved == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
            return [f"{label} should be integer"]
        numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
        if resolved == "number" and not numeric:
            return [f"{label} should be number"]
        if (
            resolved in self._TYPE_MAP
            and resolved not in {"integer", "number"}
            and not isinstance(value, self._TYPE_MAP[resolved])
        ):
            return [f"{label} should be {resolved}"]

        errors: list[str] = []
        if "enum" in schema and value not in schema["enum"]:
            errors.append(f"{label} must be one of {schema['enum']}")
        if resolved in {"integer", "number"}:
            if "minimum" in schema and value < schema["minimum"]:
                errors.append(f"{label} must be >= {schema['minimum']}")
            if "maximum" in schema and value > schema["maximum"]:
                errors.append(f"{label} must be <= {schema['maximum']}")
        if resolved == "string" and isinstance(value, str):
            if "minLength" in schema and len(value) < schema["minLength"]:
                errors.append(f"{label} must be at least {schema['minLength']} chars")
            if "maxLength" in schema and len(value) > schema["maxLength"]:
                errors.append(f"{label} must be at most {schema['maxLength']} chars")
        if resolved == "object" and isinstance(value, dict):
            properties = schema.get("properties", {})
            for key in schema.get("required", []):
                if key not in value:
                    errors.append(f"missing required {path + '.' + key if path else key}")
            for key, item in value.items():
                if key in properties:
                    child_path = f"{path}.{key}" if path else key
                    errors.extend(self._validate(item, properties[key], child_path))
        if resolved == "array" and isinstance(value, list) and "items" in schema:
            for index, item in enumerate(value):
                item_path = f"{path}[{index}]" if path else f"[{index}]"
                errors.extend(self._validate(item, schema["items"], item_path))
        return errors
