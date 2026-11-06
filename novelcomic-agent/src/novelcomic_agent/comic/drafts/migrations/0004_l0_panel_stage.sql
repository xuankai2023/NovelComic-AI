ALTER TABLE asset_artifacts DROP CONSTRAINT IF EXISTS asset_artifacts_stage_check;
ALTER TABLE asset_artifacts
  ADD CONSTRAINT asset_artifacts_stage_check CHECK (stage IN (
    'ingest', 'analyze', 'tts', 'clean-panel', 'l0-panel', 'layer-l1', 'layer-l2',
    'inpaint', 'preview', 'render-batch', 'package'
  ));
