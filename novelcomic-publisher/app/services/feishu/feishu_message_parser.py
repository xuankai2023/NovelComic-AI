"""Parse text commands sent to the Feishu bot."""

import json
import re
from typing import Any

from pydantic import ValidationError

from app.schemas.feishu import AddCreditsCommand, UpdatePlanCommand

_PAIR_RE = re.compile(r"(?P<key>email|plan|credits|remark|remake)=(?P<value>\S+)")


def parse_feishu_text_command(content: str) -> UpdatePlanCommand | AddCreditsCommand | None:
    """Parse Feishu message.content into one supported command."""
    text = _extract_text(content)
    if not text:
        return None

    pairs = _parse_pairs(text)
    email = pairs.get("email", "").strip().lower()
    if not email:
        return None

    if "plan" in pairs:
        try:
            return UpdatePlanCommand(email=email, plan=pairs["plan"].strip().lower())
        except ValidationError:
            return None

    if "credits" in pairs:
        remark = pairs.get("remark") or pairs.get("remake") or ""
        try:
            return AddCreditsCommand(
                email=email,
                credits=int(pairs["credits"]),
                remark=remark.strip(),
            )
        except (TypeError, ValueError, ValidationError):
            return None

    return None


def _extract_text(content: str) -> str:
    try:
        parsed: Any = json.loads(content)
    except json.JSONDecodeError:
        return content.strip()
    if isinstance(parsed, dict):
        text = parsed.get("text")
        if isinstance(text, str):
            return text.strip()
    return ""


def _parse_pairs(text: str) -> dict[str, str]:
    return {
        match.group("key").lower(): match.group("value").strip()
        for match in _PAIR_RE.finditer(text)
    }
