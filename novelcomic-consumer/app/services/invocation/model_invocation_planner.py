"""Stable model invocation planning for workflow nodes."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from app.services.workflow.flow_node_state_service import FlowNodeStateService


@dataclass(frozen=True)
class ModelInvocationPlan:
    execution_plan_token: str
    execution_plans: list[dict[str, Any]]
    result_id: str
    expected_result_ids: list[str] = field(default_factory=list)


class ModelInvocationPlanner:
    @staticmethod
    def _node_config(node: dict[str, Any]) -> dict[str, Any]:
        node_data = node.get("node_data") or {}
        data = node_data.get("data") if isinstance(node_data.get("data"), dict) else {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _extract_model_entry_id(entry: Any) -> str:
        if isinstance(entry, dict):
            candidate = entry.get("id") or entry.get("model_id") or entry.get("modelId") or entry.get("name")
            return str(candidate).strip() if candidate else ""
        if entry is None:
            return ""
        return str(entry).strip()

    @classmethod
    def _model_id(cls, node_config: dict[str, Any]) -> str:
        models = cls._model_ids(node_config)
        return models[0] if models else "default"

    @classmethod
    def _model_ids(cls, node_config: dict[str, Any]) -> list[str]:
        selected_models = node_config.get("selectedModels")
        if isinstance(selected_models, list) and selected_models:
            extracted = [
                cls._extract_model_entry_id(item)
                for item in selected_models
            ]
            valid = [item for item in extracted if item]
            if valid:
                return valid
        fallback = (
            node_config.get("model_id")
            or node_config.get("modelId")
            or node_config.get("model")
            or "default"
        )
        return [str(fallback)]

    @classmethod
    async def plan_node(
        cls,
        database: Any,
        *,
        run_id: str,
        node: dict[str, Any],
        inputs: dict[str, Any],
    ) -> ModelInvocationPlan:
        existing_plans = node.get("execution_plans")
        existing_result_ids = node.get("expected_result_ids")
        existing_token = node.get("execution_plan_token")
        if (
            isinstance(existing_plans, list)
            and existing_plans
            and isinstance(existing_result_ids, list)
            and existing_result_ids
            and existing_token
        ):
            normalized_ids = [str(item) for item in existing_result_ids]
            return ModelInvocationPlan(
                execution_plan_token=str(existing_token),
                execution_plans=existing_plans,
                result_id=normalized_ids[0],
                expected_result_ids=normalized_ids,
            )

        execution_plan_token = uuid4().hex
        node_config = cls._node_config(node)
        model_ids = cls._model_ids(node_config)
        execution_plans: list[dict[str, Any]] = []
        expected_result_ids: list[str] = []
        for model_id in model_ids:
            plan_result_id = uuid4().hex
            expected_result_ids.append(plan_result_id)
            execution_plans.append(
                {
                    "inputs": inputs,
                    "model_id": model_id,
                    "node_id": node["node_id"],
                    "node_type": node.get("node_type"),
                    "result_id": plan_result_id,
                }
            )
        result_id = expected_result_ids[0]
        await FlowNodeStateService.set_expected_result(
            database,
            run_id=run_id,
            node_id=str(node["node_id"]),
            result_id=result_id,
            execution_plan_token=execution_plan_token,
            execution_plans=execution_plans,
            expected_result_ids=expected_result_ids,
        )
        return ModelInvocationPlan(
            execution_plan_token=execution_plan_token,
            execution_plans=execution_plans,
            result_id=result_id,
            expected_result_ids=expected_result_ids,
        )
