"""Canvas workflow orchestration tools for the main NovelComic agent."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

from novelcomic_agent.core.tools.base import Tool

NODE_SPEC_CATALOG: dict[str, dict[str, Any]] = {
    "textInput": {
        "type": "textInput",
        "category": "input",
        "description": "Text / script prompt input node.",
        "data_fields": ["title", "text", "prompt"],
        "outputs": ["text"],
    },
    "imageInput": {
        "type": "imageInput",
        "category": "input",
        "description": "Reference image upload node.",
        "data_fields": ["title", "imageUrl", "images"],
        "outputs": ["image"],
    },
    "imageMaker": {
        "type": "imageMaker",
        "category": "image",
        "description": "Text-to-image / comic panel generation node.",
        "data_fields": ["title", "prompt", "selectedModels", "aspectRatio"],
        "default_models": ["kie-image-v1", "opencreator/text-to-image/gpt-image-2", "opencreator/text-to-image/midjourney-v7"],
        "inputs": ["text", "image"],
        "outputs": ["image"],
    },
    "imageToImage": {
        "type": "imageToImage",
        "category": "image",
        "description": "Image-to-image / character consistency edit node.",
        "data_fields": ["title", "prompt", "selectedModels", "aspectRatio"],
        "default_models": ["opencreator/image-to-image/gpt-image-2-edit", "opencreator/image-to-image/midjourney-v7"],
        "inputs": ["image", "text"],
        "outputs": ["image"],
    },
    "videoMaker": {
        "type": "videoMaker",
        "category": "video",
        "description": "Image/Text-to-video motion shot generation node.",
        "data_fields": ["title", "prompt", "selectedModels", "aspectRatio", "duration"],
        "default_models": ["opencreator/text-to-video/seedance-2.0-fast", "opencreator/text-to-video/kling-v2-master"],
        "inputs": ["text", "image"],
        "outputs": ["video"],
    },
    "textGenerator": {
        "type": "textGenerator",
        "category": "text",
        "description": "LLM script / storyboard breakdown node.",
        "data_fields": ["title", "prompt", "selectedModels"],
        "default_models": ["opencreator/text/gpt-4o-mini"],
        "inputs": ["text"],
        "outputs": ["text"],
    },
    "textToSpeech": {
        "type": "textToSpeech",
        "category": "audio",
        "description": "Dialogue voiceover synthesis node.",
        "data_fields": ["title", "prompt", "voiceId", "selectedModels"],
        "default_models": ["opencreator/text-to-speech/elevenlabs-tts"],
        "inputs": ["text"],
        "outputs": ["audio"],
    },
    "assembleNow": {
        "type": "assembleNow",
        "category": "compose",
        "description": "Remotion timeline assembly and video export node.",
        "data_fields": ["title", "aspectRatio"],
        "inputs": ["image", "video", "audio", "text"],
        "outputs": ["video"],
    },
}


def _ctx_attr(context: Any, key: str) -> Any:
    if context is None:
        return None
    if isinstance(context, Mapping):
        return context.get(key)
    value = getattr(context, key, None)
    if value is not None:
        return value
    extra = getattr(context, "extra", None)
    return extra.get(key) if isinstance(extra, Mapping) else None


class GetWorkflowTool(Tool):
    def __init__(self, context: Any | None = None) -> None:
        self._context = context

    @property
    def name(self) -> str:
        return "get_workflow"

    @property
    def description(self) -> str:
        return "Read the current canvas workflow graph (nodes and edges)."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "flow_id": {"type": "string", "description": "Optional workflow ID override."},
            },
        }

    async def execute(self, **kwargs: Any) -> str:
        flow_id = str(kwargs.get("flow_id") or _ctx_attr(self._context, "flow_id") or "").strip()
        user_id = str(_ctx_attr(self._context, "user_id") or "").strip()
        dao = _ctx_attr(self._context, "workflow_dao")
        if dao is not None and flow_id and user_id:
            workflow = await dao.get_workflow(flow_id, user_id)
            if isinstance(workflow, dict):
                return json.dumps(
                    {
                        "flow_id": flow_id,
                        "nodes": workflow.get("nodes", []),
                        "edges": workflow.get("edges", []),
                    },
                    ensure_ascii=False,
                )
        snapshot = _ctx_attr(self._context, "workflow_snapshot")
        if isinstance(snapshot, dict):
            return json.dumps(
                {
                    "flow_id": flow_id or snapshot.get("flow_id") or "",
                    "nodes": snapshot.get("nodes", []),
                    "edges": snapshot.get("edges", []),
                },
                ensure_ascii=False,
            )
        if not flow_id:
            return "Error: no flow_id in context."
        return "Error: workflow was not found."


class GetWorkflowResultsTool(Tool):
    def __init__(self, context: Any | None = None) -> None:
        self._context = context

    @property
    def name(self) -> str:
        return "get_workflow_results"

    @property
    def description(self) -> str:
        return "Read generated outputs and status for nodes in the current workflow."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "node_id": {"type": "string", "description": "Optional node ID to filter results."},
            },
        }

    async def execute(self, **kwargs: Any) -> str:
        node_id_filter = str(kwargs.get("node_id") or "").strip()
        snapshot = _ctx_attr(self._context, "workflow_snapshot") or {}
        nodes = snapshot.get("nodes") if isinstance(snapshot, dict) else []
        dao = _ctx_attr(self._context, "workflow_dao")
        flow_id = str(_ctx_attr(self._context, "flow_id") or "").strip()
        user_id = str(_ctx_attr(self._context, "user_id") or "").strip()
        if (not nodes) and dao is not None and flow_id and user_id:
            wf = await dao.get_workflow(flow_id, user_id)
            if isinstance(wf, dict):
                nodes = wf.get("nodes") or []
        results: list[dict[str, Any]] = []
        for node in nodes if isinstance(nodes, list) else []:
            if not isinstance(node, dict):
                continue
            nid = str(node.get("id") or "")
            if node_id_filter and nid != node_id_filter:
                continue
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            results.append(
                {
                    "node_id": nid,
                    "type": node.get("type"),
                    "status": data.get("status", "idle"),
                    "outputs": data.get("outputs") or node.get("outputs") or {},
                }
            )
        return json.dumps({"flow_id": flow_id, "results": results}, ensure_ascii=False)


class GetNodeSpecTool(Tool):
    @property
    def name(self) -> str:
        return "get_node_spec"

    @property
    def description(self) -> str:
        return "Get configuration schema and available models for canvas node types."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "node_type": {
                    "type": "string",
                    "description": "Node type name (e.g. imageMaker, videoMaker, textGenerator, assembleNow). Leave empty to list all.",
                },
            },
        }

    async def execute(self, **kwargs: Any) -> str:
        node_type = str(kwargs.get("node_type") or "").strip()
        if node_type:
            spec = NODE_SPEC_CATALOG.get(node_type)
            if spec is None:
                return f"Error: Unknown node_type '{node_type}'. Available: {', '.join(NODE_SPEC_CATALOG)}"
            return json.dumps(spec, ensure_ascii=False)
        return json.dumps({"node_types": NODE_SPEC_CATALOG}, ensure_ascii=False)


class EditWorkflowTool(Tool):
    def __init__(self, context: Any | None = None) -> None:
        self._context = context

    @property
    def name(self) -> str:
        return "edit_workflow"

    @property
    def description(self) -> str:
        return "Replace or update nodes and edges in the current canvas workflow."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "nodes": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Updated list of workflow nodes.",
                },
                "edges": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Updated list of workflow edges.",
                },
            },
            "required": ["nodes", "edges"],
        }

    async def execute(self, **kwargs: Any) -> str:
        nodes = kwargs.get("nodes")
        edges = kwargs.get("edges")
        if not isinstance(nodes, list) or not isinstance(edges, list):
            return "Error: nodes and edges must be arrays."
        flow_id = str(_ctx_attr(self._context, "flow_id") or "").strip()
        user_id = str(_ctx_attr(self._context, "user_id") or "").strip()
        if not flow_id or not user_id:
            return "Error: edit_workflow requires authenticated user_id and flow_id."
        dao = _ctx_attr(self._context, "workflow_dao")
        if dao is not None:
            await dao.update_workflow(flow_id, user_id, nodes, edges)
        snapshot = _ctx_attr(self._context, "workflow_snapshot")
        if isinstance(snapshot, dict):
            snapshot["nodes"] = nodes
            snapshot["edges"] = edges
        return json.dumps(
            {
                "status": "updated",
                "flow_id": flow_id,
                "node_count": len(nodes),
                "edge_count": len(edges),
            },
            ensure_ascii=False,
        )


class UpdateCanvasNodeTool(Tool):
    def __init__(self, context: Any | None = None) -> None:
        self._context = context

    @property
    def name(self) -> str:
        return "update_canvas_node"

    @property
    def description(self) -> str:
        return "Update data fields (prompt, selectedModels, aspectRatio, title) on a single canvas node."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "node_id": {"type": "string", "minLength": 1, "description": "Target node ID."},
                "data": {"type": "object", "description": "Data fields to merge into node.data."},
            },
            "required": ["node_id", "data"],
        }

    async def execute(self, **kwargs: Any) -> str:
        node_id = str(kwargs.get("node_id") or "").strip()
        patch_data = kwargs.get("data")
        if not node_id or not isinstance(patch_data, dict):
            return "Error: node_id and data object are required."
        flow_id = str(_ctx_attr(self._context, "flow_id") or "").strip()
        user_id = str(_ctx_attr(self._context, "user_id") or "").strip()
        dao = _ctx_attr(self._context, "workflow_dao")
        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        if dao is not None and flow_id and user_id:
            workflow = await dao.get_workflow(flow_id, user_id)
            if isinstance(workflow, dict):
                nodes = list(workflow.get("nodes") or [])
                edges = list(workflow.get("edges") or [])
        snapshot = _ctx_attr(self._context, "workflow_snapshot")
        if not nodes and isinstance(snapshot, dict):
            nodes = list(snapshot.get("nodes") or [])
            edges = list(snapshot.get("edges") or [])

        matched = False
        for node in nodes:
            if isinstance(node, dict) and str(node.get("id") or "") == node_id:
                current_data = dict(node.get("data") or {})
                current_data.update(patch_data)
                node["data"] = current_data
                matched = True
                break
        if not matched:
            return f"Error: node '{node_id}' not found in workflow."
        if dao is not None and flow_id and user_id:
            await dao.update_workflow(flow_id, user_id, nodes, edges)
        if isinstance(snapshot, dict):
            snapshot["nodes"] = nodes
        return json.dumps({"status": "updated", "node_id": node_id, "data": patch_data}, ensure_ascii=False)


class SearchTemplatesTool(Tool):
    def __init__(self, context: Any | None = None) -> None:
        self._context = context

    @property
    def name(self) -> str:
        return "search_templates"

    @property
    def description(self) -> str:
        return "Search workflow templates by keyword or category."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search keyword."},
                "category": {"type": "string", "description": "Optional template category."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            },
        }

    async def execute(self, **kwargs: Any) -> str:
        query = str(kwargs.get("query") or "").strip().lower()
        limit = int(kwargs.get("limit") or 5)
        templates_col = _ctx_attr(self._context, "templates_col")
        items: list[dict[str, Any]] = []
        if templates_col is not None and hasattr(templates_col, "find"):
            cursor = templates_col.find({})
            async for doc in cursor:
                if not isinstance(doc, dict):
                    continue
                title = str(doc.get("title") or doc.get("name") or "")
                desc = str(doc.get("description") or "")
                if query and query not in title.lower() and query not in desc.lower():
                    continue
                items.append(
                    {
                        "template_id": str(doc.get("template_id") or doc.get("_id") or ""),
                        "title": title,
                        "description": desc,
                        "category": doc.get("category") or "comic",
                    }
                )
                if len(items) >= limit:
                    break
        if not items:
            items = [
                {
                    "template_id": "tpl-dynamic-comic-starter",
                    "title": "Dynamic Comic Storyboard & Video",
                    "description": "Generate multi-panel comic art, voiceover, and motion video.",
                    "category": "comic",
                }
            ]
        return json.dumps({"templates": items}, ensure_ascii=False)


class UseTemplateTool(Tool):
    def __init__(self, context: Any | None = None) -> None:
        self._context = context

    @property
    def name(self) -> str:
        return "use_template"

    @property
    def description(self) -> str:
        return "Apply a workflow template into the current canvas project."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "template_id": {"type": "string", "minLength": 1, "description": "Template ID to apply."},
            },
            "required": ["template_id"],
        }

    async def execute(self, **kwargs: Any) -> str:
        template_id = str(kwargs.get("template_id") or "").strip()
        flow_id = str(_ctx_attr(self._context, "flow_id") or "").strip()
        user_id = str(_ctx_attr(self._context, "user_id") or "").strip()
        if not flow_id or not user_id:
            return "Error: use_template requires authenticated user_id and flow_id."
        templates_col = _ctx_attr(self._context, "templates_col")
        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        if templates_col is not None and hasattr(templates_col, "find_one"):
            tpl = await templates_col.find_one({"template_id": template_id})
            if isinstance(tpl, dict):
                nodes = list(tpl.get("nodes") or [])
                edges = list(tpl.get("edges") or [])
        if not nodes:
            nodes = [
                {
                    "id": "Input-1",
                    "type": "textInput",
                    "position": {"x": 120, "y": 160},
                    "data": {"title": "Story Prompt", "text": ""},
                },
                {
                    "id": "ImageMaker-1",
                    "type": "imageMaker",
                    "position": {"x": 460, "y": 160},
                    "data": {
                        "title": "Comic Panel Generator",
                        "prompt": "",
                        "selectedModels": ["kie-image-v1"],
                        "aspectRatio": "16:9",
                    },
                },
            ]
            edges = [{"id": "e-input-image", "source": "Input-1", "target": "ImageMaker-1"}]
        dao = _ctx_attr(self._context, "workflow_dao")
        if dao is not None:
            await dao.update_workflow(flow_id, user_id, nodes, edges)
        snapshot = _ctx_attr(self._context, "workflow_snapshot")
        if isinstance(snapshot, dict):
            snapshot["nodes"] = nodes
            snapshot["edges"] = edges
        return json.dumps(
            {
                "status": "applied",
                "template_id": template_id,
                "flow_id": flow_id,
                "node_count": len(nodes),
            },
            ensure_ascii=False,
        )


class HitlTool(Tool):
    @property
    def name(self) -> str:
        return "hitl"

    @property
    def description(self) -> str:
        return "Pause the agent run and ask the user to select an option or answer a question."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["select", "ask"],
                    "description": "Interaction type: 'select' for option cards or 'ask' for freeform question.",
                },
                "title": {"type": "string", "description": "Card title shown to the user."},
                "message": {"type": "string", "description": "Prompt message shown to the user."},
                "options": {
                    "type": "array",
                    "items": {"type": "object"},
                    "description": "Selectable options when type='select'.",
                },
            },
            "required": ["message"],
        }

    async def execute(self, **kwargs: Any) -> str:
        from novelcomic_agent.core.loop import HitlInterrupt

        hitl_type = str(kwargs.get("type") or "select")
        if hitl_type not in {"select", "ask"}:
            hitl_type = "select"
        data = {
            "title": kwargs.get("title") or "Please confirm",
            "message": kwargs.get("message") or "",
            "options": kwargs.get("options") or [],
        }
        raise HitlInterrupt(
            tool_call_id=f"hitl_{uuid4().hex[:8]}",
            hitl_type=hitl_type,
            data=data,
            tool_name=self.name,
        )
