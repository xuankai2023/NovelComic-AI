from novelcomic_agent.comic.contracts.ids import (
    make_shot_id,
    make_stable_line_key,
    page_id_from_bytes,
)


def test_comic_ids_are_deterministic() -> None:
    source = b"same source page"
    page_id = page_id_from_bytes(source)

    assert page_id_from_bytes(source) == page_id
    assert make_stable_line_key(page_id, 2, 3, 0) == f"line:{page_id}:2:3:0"
    assert make_shot_id(page_id, 2, 0) == f"shot:{page_id}:2:part:0"


def test_page_id_changes_with_source_bytes() -> None:
    assert page_id_from_bytes(b"one") != page_id_from_bytes(b"two")
