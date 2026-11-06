#!/usr/bin/env python3
"""Offline validator for CI and migration fixtures; runtime rules live in TS."""
from __future__ import annotations
import json, sys
from pathlib import Path
from typing import Any

def validate(doc: Any) -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    if not isinstance(doc, dict): return [{'code': 'DOCUMENT_NOT_OBJECT', 'path': '', 'message': 'Document must be an object'}]
    if doc.get('schemaVersion') != 1: errors.append({'code': 'SCHEMA_TOO_NEW' if doc.get('schemaVersion', 0) > 1 else 'SCHEMA_VERSION_INVALID', 'path': 'schemaVersion', 'message': 'Unsupported document schema version'})
    for field in ('documentId', 'projectId', 'name'):
        if not isinstance(doc.get(field), str) or not doc[field]: errors.append({'code': 'REQUIRED_FIELD', 'path': field, 'message': f'{field} is required'})
    for field in ('width', 'height'):
        if not isinstance(doc.get(field), int) or not 1 <= doc[field] <= 32768: errors.append({'code': 'CANVAS_SIZE_INVALID', 'path': field, 'message': f'{field} must be an integer within 1..32768'})
    if not isinstance(doc.get('resolution'), (int, float)) or not 1 <= doc['resolution'] <= 2400: errors.append({'code': 'RESOLUTION_INVALID', 'path': 'resolution', 'message': 'resolution must be within 1..2400'})
    layers = doc.get('layers'); roots = doc.get('rootLayerIds')
    if not isinstance(layers, dict) or not isinstance(roots, list): return errors + [{'code': 'LAYER_TABLE_INVALID', 'path': 'layers', 'message': 'layers and rootLayerIds are required'}]
    if len(set(roots)) != len(roots): errors.append({'code': 'ROOT_DUPLICATE', 'path': 'rootLayerIds', 'message': 'Root layer ids must be unique'})
    for root in roots:
        if root not in layers: errors.append({'code': 'MISSING_LAYER', 'path': f'rootLayerIds.{root}', 'message': 'Root layer does not exist'})
    orders: dict[Any, set[int]] = {}
    for ident, layer in layers.items():
        if layer.get('id') != ident: errors.append({'code': 'LAYER_ID_MISMATCH', 'path': f'layers.{ident}.id', 'message': 'Layer key and id must match'})
        parent = layer.get('parentId')
        if parent is not None and (parent not in layers or layers[parent].get('kind') != 'group'): errors.append({'code': 'INVALID_PARENT', 'path': f'layers.{ident}.parentId', 'message': 'Parent must be an existing group'})
        order = layer.get('order'); sibling = orders.setdefault(parent, set())
        if not isinstance(order, int) or order < 0 or order in sibling: errors.append({'code': 'ORDER_INVALID', 'path': f'layers.{ident}.order', 'message': 'Sibling order must be unique and non-negative'})
        sibling.add(order)
        if not isinstance(layer.get('opacity'), (int, float)) or not 0 <= layer['opacity'] <= 1: errors.append({'code': 'OPACITY_INVALID', 'path': f'layers.{ident}.opacity', 'message': 'Opacity must be within 0..1'})
        current, seen, depth = ident, set(), 0
        while current is not None:
            if current in seen: errors.append({'code': 'LAYER_CYCLE', 'path': f'layers.{ident}', 'message': 'Layer parent cycle detected'}); break
            seen.add(current); current = layers.get(current, {}).get('parentId'); depth += 1
            if depth > 64: errors.append({'code': 'LAYER_DEPTH_EXCEEDED', 'path': f'layers.{ident}', 'message': 'Layer nesting is too deep'}); break
    return errors

if __name__ == '__main__':
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    document = json.loads(path.read_text(encoding='utf-8') if path else sys.stdin.read())
    issues = validate(document)
    print(json.dumps({'valid': not issues, 'issues': issues}, ensure_ascii=False, indent=2))
    raise SystemExit(1 if issues else 0)
