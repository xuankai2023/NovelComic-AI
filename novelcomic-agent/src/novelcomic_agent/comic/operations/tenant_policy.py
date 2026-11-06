"""Tenant decisions only. Quota totals are committed by the repositories."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Actor = Literal["user", "admin", "system"]


@dataclass(frozen=True, slots=True)
class AuthContext:
    tenant_id: str | None
    known_tenants: frozenset[str]
    actor: Actor = "user"


@dataclass(frozen=True, slots=True)
class QuotaFacts:
    concurrent_jobs: int
    concurrent_limit: int
    daily_spend_fen: int
    daily_limit_fen: int
    monthly_spend_fen: int
    monthly_limit_fen: int
    enabled_features: frozenset[str]
    delivery_enabled: bool = True


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    allowed: bool
    reason: str


def evaluate(
    context: AuthContext,
    *,
    resource_tenant_id: str,
    facts: QuotaFacts,
    feature: str,
) -> PolicyDecision:
    if not context.tenant_id:
        return PolicyDecision(False, "missing-tenant")
    if context.tenant_id not in context.known_tenants:
        return PolicyDecision(False, "unknown-tenant")
    if context.tenant_id != resource_tenant_id:
        return PolicyDecision(False, "cross-tenant")
    if feature not in facts.enabled_features:
        return PolicyDecision(False, "feature-disabled")
    if facts.concurrent_jobs >= facts.concurrent_limit:
        return PolicyDecision(False, "concurrent-quota")
    if facts.daily_spend_fen >= facts.daily_limit_fen:
        return PolicyDecision(False, "daily-budget")
    if facts.monthly_spend_fen >= facts.monthly_limit_fen:
        return PolicyDecision(False, "monthly-budget")
    if feature == "delivery" and not facts.delivery_enabled:
        return PolicyDecision(False, "delivery-forbidden")
    return PolicyDecision(True, "allowed")


def may_cancel(context: AuthContext, *, resource_tenant_id: str) -> PolicyDecision:
    if not context.tenant_id:
        return PolicyDecision(False, "missing-tenant")
    if context.tenant_id not in context.known_tenants and context.actor != "admin":
        return PolicyDecision(False, "unknown-tenant")
    if context.actor == "admin":
        if resource_tenant_id not in context.known_tenants:
            return PolicyDecision(False, "unknown-tenant")
        return PolicyDecision(True, "admin-cancel")
    if context.tenant_id != resource_tenant_id:
        return PolicyDecision(False, "cross-tenant")
    return PolicyDecision(True, "user-cancel")


DEFAULT_FEATURES = frozenset({"preview", "review", "auto-fix", "package", "delivery"})


@dataclass(frozen=True, slots=True)
class TenantDirectory:
    known_tenants: frozenset[str]
    features: frozenset[str] = DEFAULT_FEATURES
    concurrent_limit: int = 8
    daily_limit_fen: int = 10**12
    monthly_limit_fen: int = 10**12
    delivery_enabled: bool = True


def quota_facts(directory: TenantDirectory) -> QuotaFacts:
    return QuotaFacts(
        concurrent_jobs=0,
        concurrent_limit=directory.concurrent_limit,
        daily_spend_fen=0,
        daily_limit_fen=directory.daily_limit_fen,
        monthly_spend_fen=0,
        monthly_limit_fen=directory.monthly_limit_fen,
        enabled_features=directory.features,
        delivery_enabled=directory.delivery_enabled,
    )


def auth_context(
    directory: TenantDirectory,
    tenant_id: str | None,
    *,
    actor: Actor = "system",
) -> AuthContext:
    return AuthContext(tenant_id=tenant_id, known_tenants=directory.known_tenants, actor=actor)
