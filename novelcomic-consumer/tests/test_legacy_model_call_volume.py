import pytest

from app.services.opencreator_ai.legacy_call_volume import (
    legacy_call_volume,
    reset_legacy_call_volume,
)
from app.services.opencreator_ai.model_mapper import (
    MissingOpenCreatorAIModelMapping,
    OpenCreatorAIModelMapper,
)


def test_legacy_model_id_lookup_increments_call_volume() -> None:
    reset_legacy_call_volume()
    assert OpenCreatorAIModelMapper.to_opencreator_model_id("z-image") == "kie-image-v1"
    assert (
        OpenCreatorAIModelMapper.to_opencreator_model_id("default", "imageModel") == "kie-image-v1"
    )
    assert legacy_call_volume()["legacy_model_id"] == 2

    with pytest.raises(MissingOpenCreatorAIModelMapping):
        OpenCreatorAIModelMapper.to_opencreator_model_id("not-a-legacy-id")
    assert legacy_call_volume()["legacy_model_id"] == 2


def test_gpt_image_2_canvas_names_map_without_counting_canonical_ids() -> None:
    reset_legacy_call_volume()
    assert (
        OpenCreatorAIModelMapper.to_opencreator_model_id("openai/gpt-image-2")
        == "opencreator/text-to-image/gpt-image-2"
    )
    assert (
        OpenCreatorAIModelMapper.to_opencreator_model_id("openai/gpt-image-2/edit")
        == "opencreator/image-to-image/gpt-image-2-edit"
    )
    assert legacy_call_volume()["legacy_model_id"] == 2
    assert (
        OpenCreatorAIModelMapper.to_opencreator_model_id("opencreator/text-to-image/gpt-image-2")
        == "opencreator/text-to-image/gpt-image-2"
    )
    assert legacy_call_volume()["legacy_model_id"] == 2
