"""Mongo access for invite relations and reward records."""

from datetime import datetime
from typing import Any

from app.schemas.invite import InviteCreditRecord, InviteRelation, normalize_invite_code


async def _cursor_to_list(cursor: Any) -> list[dict]:
    if hasattr(cursor, "to_list"):
        return await cursor.to_list(length=None)
    return list(cursor)


def _without_id(document: dict | None) -> dict | None:
    if document is None:
        return None
    result = dict(document)
    result.pop("_id", None)
    return result


class InviteDao:
    USERS = "users"
    RELATIONS = "invite_relations"
    CREDITS = "invite_credit_records"

    @classmethod
    async def find_user_by_invite_code(cls, database: Any, invite_code: str) -> dict | None:
        normalized = normalize_invite_code(invite_code)
        if not normalized:
            return None
        return _without_id(await database[cls.USERS].find_one({"invite_code": normalized}))

    @classmethod
    async def set_user_invite_code(cls, database: Any, user_id: str, invite_code: str) -> None:
        await database[cls.USERS].update_one(
            {"user_id": user_id},
            {"$set": {"invite_code": invite_code}},
        )

    @classmethod
    async def find_relation_by_invitee(
        cls,
        database: Any,
        invitee_user_id: str,
    ) -> InviteRelation | None:
        document = _without_id(
            await database[cls.RELATIONS].find_one({"invitee_user_id": invitee_user_id})
        )
        return InviteRelation(**document) if document else None

    @classmethod
    async def create_relation(
        cls,
        database: Any,
        relation: InviteRelation,
    ) -> InviteRelation:
        existing = await cls.find_relation_by_invitee(database, relation.invitee_user_id)
        if existing is not None:
            return existing
        await database[cls.RELATIONS].insert_one(relation.model_dump(mode="json"))
        return relation

    @classmethod
    async def mark_paid_rewarded(
        cls,
        database: Any,
        invitee_user_id: str,
        paid_at: datetime,
    ) -> None:
        await database[cls.RELATIONS].update_one(
            {"invitee_user_id": invitee_user_id},
            {"$set": {"paid_rewarded": True, "paid_at": paid_at}},
        )

    @classmethod
    async def count_register_rewards(cls, database: Any, inviter_user_id: str) -> int:
        return await database[cls.CREDITS].count_documents(
            {"inviter_user_id": inviter_user_id, "reward_type": "register"}
        )

    @classmethod
    async def find_credit_record(
        cls,
        database: Any,
        *,
        invitee_user_id: str,
        reward_type: str,
    ) -> InviteCreditRecord | None:
        document = _without_id(
            await database[cls.CREDITS].find_one(
                {"invitee_user_id": invitee_user_id, "reward_type": reward_type}
            )
        )
        return InviteCreditRecord(**document) if document else None

    @classmethod
    async def insert_credit_record(
        cls,
        database: Any,
        record: InviteCreditRecord,
    ) -> InviteCreditRecord:
        existing = await cls.find_credit_record(
            database,
            invitee_user_id=record.invitee_user_id,
            reward_type=record.reward_type,
        )
        if existing is not None:
            return existing
        await database[cls.CREDITS].insert_one(record.model_dump(mode="json"))
        return record

    @classmethod
    async def list_relations(
        cls,
        database: Any,
        inviter_user_id: str,
        *,
        page: int,
        page_size: int,
    ) -> tuple[list[InviteRelation], int]:
        query = {"inviter_user_id": inviter_user_id}
        total = await database[cls.RELATIONS].count_documents(query)
        cursor = (
            database[cls.RELATIONS]
            .find(query, {"_id": 0})
            .sort("created_at", -1)
            .skip((page - 1) * page_size)
            .limit(page_size)
        )
        items = [InviteRelation(**doc) for doc in await _cursor_to_list(cursor)]
        return items, total

    @classmethod
    async def list_credit_records(
        cls,
        database: Any,
        inviter_user_id: str,
        *,
        page: int,
        page_size: int,
    ) -> tuple[list[InviteCreditRecord], int]:
        query = {"inviter_user_id": inviter_user_id}
        total = await database[cls.CREDITS].count_documents(query)
        cursor = (
            database[cls.CREDITS]
            .find(query, {"_id": 0})
            .sort("created_at", -1)
            .skip((page - 1) * page_size)
            .limit(page_size)
        )
        items = [InviteCreditRecord(**doc) for doc in await _cursor_to_list(cursor)]
        return items, total

    @classmethod
    async def summarize(cls, database: Any, inviter_user_id: str) -> dict[str, int]:
        cursor = database[cls.CREDITS].find({"inviter_user_id": inviter_user_id}, {"_id": 0})
        records = await _cursor_to_list(cursor)
        invited_count = await database[cls.RELATIONS].count_documents(
            {"inviter_user_id": inviter_user_id}
        )
        register_points = sum(
            int(record.get("points", 0))
            for record in records
            if record.get("reward_type") == "register"
        )
        paid_points = sum(
            int(record.get("points", 0))
            for record in records
            if record.get("reward_type") == "paid"
        )
        return {
            "invited_count": invited_count,
            "register_points": register_points,
            "paid_points": paid_points,
            "total_points": register_points + paid_points,
        }
