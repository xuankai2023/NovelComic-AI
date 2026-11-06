#!/usr/bin/env python3
"""Canonical JSON used by the TypeScript document hash implementation."""
from __future__ import annotations
import json, math, sys
from typing import Any

def canonicalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonicalize(value[key]) for key in sorted(value, key=lambda k: k.encode('utf-8')) if value[key] is not None or key in value}
    if isinstance(value, list):
        return [canonicalize(item) for item in value]
    if isinstance(value, float):
        if not math.isfinite(value): raise ValueError('non-finite number')
        if value == 0: return 0
        return int(value) if value.is_integer() else value
    return value

def dumps(value: Any) -> str:
    return json.dumps(canonicalize(value), ensure_ascii=False, separators=(',', ':'), allow_nan=False)

if __name__ == '__main__':
    source = json.load(sys.stdin)
    sys.stdout.write(dumps(source))
