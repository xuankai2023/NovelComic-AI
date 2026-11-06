"""Draft metadata for personal Agent Skills. This does not write runtime skills."""

from __future__ import annotations

from pathlib import PurePath

from fastapi import HTTPException

from app.schemas.agent_skills import (
    MAX_FILE_BYTES,
    AgentSkillDraft,
    GenerateAgentSkillDraftRequest,
    SourceType,
)

_TEXT_EXTENSIONS = {".txt", ".md", ".yaml", ".yml"}


def generate_text_metadata(source_text: str, *, source_type: SourceType) -> AgentSkillDraft:
    text = source_text.strip()
    title = _title_from_text(text)
    scenes = _scenes_from_text(text)
    tags = _tags_from_text(text)
    return AgentSkillDraft(
        title=title,
        description=text[:240],
        scenes=scenes,
        ai_tags=tags,
        original_prompt=source_text,
        source_type=source_type,
        generation_metadata={"generator": "text"},
    )


def generate_from_video(video_url: str, supplemental_text: str | None = None) -> AgentSkillDraft:
    source = (supplemental_text or "").strip() or video_url
    draft = generate_text_metadata(source, source_type="video")
    draft.generation_metadata = {"generator": "video", "video_url": video_url}
    draft.original_prompt = supplemental_text or video_url
    return draft


def normalize_compiled_values(draft: AgentSkillDraft) -> AgentSkillDraft:
    return draft.model_copy(
        update={
            "title": draft.title.strip()[:80] or "未命名技能",
            "description": draft.description.strip()[:500],
            "scenes": draft.scenes[:8] or ["默认场景"],
            "ai_tags": draft.ai_tags[:12],
        }
    )


def draft_from_request(request: GenerateAgentSkillDraftRequest) -> AgentSkillDraft:
    if request.source_type == "file":
        file_name = request.file_name or ""
        suffix = PurePath(file_name).suffix.lower()
        if suffix not in _TEXT_EXTENSIONS:
            raise HTTPException(status_code=400, detail={"code": "UNSUPPORTED_FILE_TYPE"})
        file_text = request.file_text or ""
        if len(file_text.encode("utf-8")) > MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail={"code": "FILE_TOO_LARGE"})
        return normalize_compiled_values(generate_text_metadata(file_text, source_type="file"))
    if request.source_type == "video":
        supplemental = request.supplemental_text or request.original_prompt
        return normalize_compiled_values(generate_from_video(request.video_url or "", supplemental))
    draft = generate_text_metadata(request.original_prompt, source_type="prompt")
    return normalize_compiled_values(draft)


def _title_from_text(text: str) -> str:
    first = text.splitlines()[0].strip() if text else ""
    return (first[:80] or "未命名技能")


def _scenes_from_text(text: str) -> list[str]:
    pieces = [part.strip(" 。.;") for part in text.replace("\n", "。").split("。")]
    scenes = list(dict.fromkeys(part for part in pieces if part))
    return scenes[:8] or ["默认场景"]


def _tags_from_text(text: str) -> list[str]:
    words = [word.strip("，,。.") for word in text.replace("\n", " ").split(" ") if word.strip()]
    tags = list(dict.fromkeys(word[:32] for word in words if word))
    return tags[:12]
