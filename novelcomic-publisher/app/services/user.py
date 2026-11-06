"""本地业务用户。身份在 Clerk，这里只按 user_id 落库和查询。"""

from datetime import UTC, datetime
from typing import Any

from app.services.invite import InviteService


class UserService:
    COLLECTION = "users"

    @classmethod
    async def get_user_by_id(cls, database: Any, user_id: str) -> dict | None:
        document = await database[cls.COLLECTION].find_one({"user_id": user_id}, {"_id": 0})
        if document is None:
            return None
        invite_code = document.get("invite_code") or InviteService.generate_invite_code(user_id)
        return {
            "user_id": document["user_id"],
            "user_email": document.get("user_email"),
            "credits": document.get("credits", 0),
            "invite_code": invite_code,
            "system_level": int(document.get("system_level") or 0),
            "is_new_user": bool(document.get("is_new_user", False)),
            "is_abnormal_user": bool(document.get("is_abnormal_user", False)),
            "source": document.get("source") or "direct",
            "preferences": document.get("preferences") or {},
        }

    @classmethod
    async def create_user(
        cls,
        database: Any,
        user_id: str,
        user_email: str | None,
        *,
        first_name: str | None = None,
        last_name: str | None = None,
        fp_hash: str | None = None,
        fp_timezone: str | None = None,
        client_ip: str | None = None,
        source: str | None = None,
        is_abnormal_user: bool = False,
        system_level: int = 0,
    ) -> dict:
        now = datetime.now(UTC)
        normalized_source = (
            source if source in {"direct", "template", "shared_template"} else "direct"
        )
        document = {
            "user_id": user_id,
            "user_email": user_email,
            "credits": 0,
            "invite_code": InviteService.generate_invite_code(user_id),
            "first_name": first_name,
            "last_name": last_name,
            "fp_hash": fp_hash or "",
            "fp_timezone": fp_timezone or "",
            "client_ip": client_ip,
            "source": normalized_source,
            "is_new_user": True,
            "is_abnormal_user": bool(is_abnormal_user),
            "system_level": int(system_level),
            "preferences": {},
            "created_at": now,
            "updated_at": now,
        }
        await database[cls.COLLECTION].insert_one(dict(document))
        return document

    @classmethod
    async def update_preferences(
        cls,
        database: Any,
        user_id: str,
        preferences: dict[str, Any],
    ) -> dict[str, Any]:
        existing = await database[cls.COLLECTION].find_one({"user_id": user_id}) or {}
        merged = {**(existing.get("preferences") or {}), **preferences}
        await database[cls.COLLECTION].update_one(
            {"user_id": user_id},
            {
                "$set": {
                    "preferences": merged,
                    "is_new_user": False,
                    "updated_at": datetime.now(UTC),
                }
            },
        )
        return merged
