"""Invite binding and reward rules."""

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any

from app.dao.invite import InviteDao
from app.schemas.invite import (
    InviteCreditRecord,
    InviteCreditRecordPage,
    InviteRelation,
    InviteRelationPage,
    InviteSummary,
    normalize_invite_code,
)
from app.services.unified_credits.__base.constants.redis_keys import credits_idempotency_key
from app.services.unified_credits.credits_cache import CreditsCache
from app.services.unified_credits.unified_credits_service import UnifiedCreditsService


class InviteService:
    REGISTER_REWARD_POINTS = 200
    PAID_REWARD_POINTS = 1000
    MAX_REGISTER_REWARDS = 10
    PAID_REWARD_WINDOW = timedelta(days=7)

    @classmethod
    def generate_invite_code(cls, user_id: str) -> str:
        digest = hashlib.sha1(user_id.encode("utf-8")).hexdigest().upper()
        return f"NC{digest[:8]}"

    @classmethod
    async def ensure_user_invite_code(cls, database: Any, user_id: str) -> str:
        code = cls.generate_invite_code(user_id)
        await InviteDao.set_user_invite_code(database, user_id, code)
        return code

    @classmethod
    async def bind_registered_user(
        cls,
        database: Any,
        *,
        invitee_user_id: str,
        invitee_email: str | None,
        invite_code: str | None,
        now: datetime | None = None,
    ) -> InviteRelation | None:
        normalized_code = normalize_invite_code(invite_code)
        if not normalized_code:
            return None

        existing = await InviteDao.find_relation_by_invitee(database, invitee_user_id)
        if existing is not None:
            if existing.registration_rewarded:
                await cls._grant_invite_credits_safely(
                    database,
                    inviter_user_id=existing.inviter_user_id,
                    invitee_user_id=invitee_user_id,
                    reward_type="register",
                    points=cls.REGISTER_REWARD_POINTS,
                )
            return existing

        inviter = await InviteDao.find_user_by_invite_code(database, normalized_code)
        if inviter is None or inviter.get("user_id") == invitee_user_id:
            return None

        created_at = now or datetime.now(UTC)
        can_reward = (
            await InviteDao.count_register_rewards(database, inviter["user_id"])
        ) < cls.MAX_REGISTER_REWARDS
        relation = InviteRelation(
            invite_code=normalized_code,
            inviter_user_id=inviter["user_id"],
            invitee_user_id=invitee_user_id,
            invitee_email=invitee_email,
            created_at=created_at,
            registration_rewarded=can_reward,
        )
        relation = await InviteDao.create_relation(database, relation)
        if can_reward and relation.registration_rewarded:
            await InviteDao.insert_credit_record(
                database,
                InviteCreditRecord(
                    inviter_user_id=inviter["user_id"],
                    invitee_user_id=invitee_user_id,
                    reward_type="register",
                    points=cls.REGISTER_REWARD_POINTS,
                    source_id=f"register:{invitee_user_id}",
                    created_at=created_at,
                ),
            )
            await cls._grant_invite_credits_safely(
                database,
                inviter_user_id=inviter["user_id"],
                invitee_user_id=invitee_user_id,
                reward_type="register",
                points=cls.REGISTER_REWARD_POINTS,
            )
        return relation

    @classmethod
    async def reward_paid_user(
        cls,
        database: Any,
        *,
        invitee_user_id: str,
        source_id: str,
        paid_at: datetime | None = None,
    ) -> InviteCreditRecord | None:
        relation = await InviteDao.find_relation_by_invitee(database, invitee_user_id)
        if relation is None:
            return None

        paid_time = paid_at or datetime.now(UTC)
        if paid_time - relation.created_at > cls.PAID_REWARD_WINDOW:
            return None
        if await InviteDao.find_credit_record(
            database,
            invitee_user_id=invitee_user_id,
            reward_type="paid",
        ):
            return None

        record = await InviteDao.insert_credit_record(
            database,
            InviteCreditRecord(
                inviter_user_id=relation.inviter_user_id,
                invitee_user_id=invitee_user_id,
                reward_type="paid",
                points=cls.PAID_REWARD_POINTS,
                source_id=source_id,
                created_at=paid_time,
            ),
        )
        await InviteDao.mark_paid_rewarded(database, invitee_user_id, paid_time)
        await cls._grant_invite_credits_safely(
            database,
            inviter_user_id=relation.inviter_user_id,
            invitee_user_id=invitee_user_id,
            reward_type="paid",
            points=cls.PAID_REWARD_POINTS,
        )
        return record

    @classmethod
    async def _grant_invite_credits_safely(
        cls,
        database: Any,
        *,
        inviter_user_id: str,
        invitee_user_id: str,
        reward_type: str,
        points: int,
    ) -> None:
        idempotency_key = f"invite:{reward_type}:{inviter_user_id}:{invitee_user_id}"
        inout_col = database["credits_inout_record"]
        existing_grant = (
            await inout_col.find_one({"idempotency_key": f"invite_reward:{idempotency_key}"})
            or await inout_col.find_one({"source_id": idempotency_key})
            or await inout_col.find_one({"idempotency_key": idempotency_key})
        )
        if existing_grant is not None:
            return
        await CreditsCache.delete_quietly(credits_idempotency_key(idempotency_key))
        await UnifiedCreditsService.add_topup_credits(
            database,
            user_id=inviter_user_id,
            amount=points,
            source=f"invite_{reward_type}",
            idempotency_key=idempotency_key,
        )

    @classmethod
    async def get_summary(cls, database: Any, user_id: str) -> InviteSummary:
        summary = await InviteDao.summarize(database, user_id)
        invite_code = cls.generate_invite_code(user_id)
        return InviteSummary(
            invite_code=invite_code,
            invite_link_path=f"/?invite={invite_code}",
            **summary,
        )

    @classmethod
    async def list_invitees(
        cls,
        database: Any,
        user_id: str,
        *,
        page: int = 1,
        page_size: int = 20,
    ) -> InviteRelationPage:
        safe_page = max(page, 1)
        safe_page_size = min(max(page_size, 1), 100)
        items, total = await InviteDao.list_relations(
            database,
            user_id,
            page=safe_page,
            page_size=safe_page_size,
        )
        return InviteRelationPage(
            items=items,
            total=total,
            page=safe_page,
            page_size=safe_page_size,
        )

    @classmethod
    async def list_credit_records(
        cls,
        database: Any,
        user_id: str,
        *,
        page: int = 1,
        page_size: int = 20,
    ) -> InviteCreditRecordPage:
        safe_page = max(page, 1)
        safe_page_size = min(max(page_size, 1), 100)
        items, total = await InviteDao.list_credit_records(
            database,
            user_id,
            page=safe_page,
            page_size=safe_page_size,
        )
        return InviteCreditRecordPage(
            items=items,
            total=total,
            page=safe_page,
            page_size=safe_page_size,
        )
