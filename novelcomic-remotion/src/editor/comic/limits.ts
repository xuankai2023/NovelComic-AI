export const LEGACY_SCHEMA_VERSION = 1;
export const COMIC_SCHEMA_VERSION = 3;

export const COMIC_DEFAULT_WIDTH = 1080;
export const COMIC_DEFAULT_HEIGHT = 1920;
export const COMIC_DEFAULT_FPS = 30;

export const MAX_SHOTS = 500;
export const MAX_ITEMS = 10_000;
export const MAX_ASSETS = 20_000;
export const MAX_KEYFRAMES_PER_ITEM = 2_000;
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

export const MIN_BATCH_SECONDS = 5;
export const TARGET_BATCH_SECONDS_MIN = 15;
export const MAX_BATCH_SECONDS = 18;

export const batchDurationFrames = (
	fps: number,
): {min: number; targetMin: number; max: number} => {
	return {
		min: MIN_BATCH_SECONDS * fps,
		targetMin: TARGET_BATCH_SECONDS_MIN * fps,
		max: MAX_BATCH_SECONDS * fps,
	};
};
