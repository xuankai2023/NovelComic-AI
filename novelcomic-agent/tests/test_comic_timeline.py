"""Deterministic shot timelines and the 30fps clock."""

from novelcomic_agent.comic.audio.timeline_planner import TimelineLine, TimelinePanel, plan_timeline
from novelcomic_agent.comic.contracts.ids import make_stable_line_key, page_id_from_bytes
from novelcomic_agent.comic.contracts.line_audio import LineAudio
from novelcomic_agent.comic.units import frames_from_ms

PAGE = page_id_from_bytes(b"timeline-page")


def _line(text: str, clause: int, *, duration_ms: int | None) -> TimelineLine:
    audio = None
    if duration_ms is not None:
        audio = LineAudio(
            stable_line_key=make_stable_line_key(PAGE, 0, 0, clause),
            audio_url="https://cdn.example/line.mp3",  # type: ignore[arg-type]
            duration_ms=duration_ms,
        )
    return TimelineLine(
        stable_line_key=make_stable_line_key(PAGE, 0, 0, clause),
        text=text,
        speaker_id=None,
        audio=audio,
    )


def _panel(*lines: TimelineLine) -> TimelinePanel:
    return TimelinePanel(
        page_id=PAGE,
        panel_index=0,
        reading_order=0,
        panel_url="https://cdn.example/panel.png",
        lines=lines,
    )


def test_timeline_is_deterministic_and_keeps_dialogue_inside_the_shot() -> None:
    panel = _panel(_line("hello", 0, duration_ms=800), _line("again", 1, duration_ms=800))
    first = plan_timeline([panel], seed=7)
    second = plan_timeline([panel], seed=7)
    assert first.shots[0].model_dump(mode="json") == second.shots[0].model_dump(mode="json")
    shot = first.shots[0]
    for dialogue in shot.dialogues:
        end = dialogue.from_frame + dialogue.duration_in_frames
        assert end <= shot.duration_in_frames
    assert first.needs_project_pad is True


def test_long_panel_splits_between_lines() -> None:
    lines = tuple(_line(f"line-{index}", index, duration_ms=7000) for index in range(2))
    plan = plan_timeline([_panel(*lines)], seed=3)
    assert [shot.panel_part_index for shot in plan.shots] == [0, 1]
    assert all(len(shot.dialogues) == 1 for shot in plan.shots)


def test_missing_audio_still_has_duration_and_short_projects_need_padding() -> None:
    plan = plan_timeline([_panel(_line("hi", 0, duration_ms=None))], seed=1)
    assert plan.shots[0].dialogues[0].duration_in_frames > 0
    assert plan.shots[0].dialogues[0].voice_url is None
    assert plan.needs_project_pad is True
    assert frames_from_ms(1000) == 30
    assert frames_from_ms(1001) == 31
