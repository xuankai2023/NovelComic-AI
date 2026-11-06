import {COMIC_ERROR_CODES, ComicEditorError, domainInvariant} from './errors';
import {MAX_KEYFRAMES_PER_ITEM} from './limits';

export type MotionIds = {
	shotId?: string;
	itemId?: string;
};

export const assertUniqueFrames = (
	frames: readonly number[],
	durationInFrames: number,
	label: string,
	ids: MotionIds,
): void => {
	if (frames.length > MAX_KEYFRAMES_PER_ITEM) {
		throw new ComicEditorError({
			code: COMIC_ERROR_CODES.PAYLOAD_TOO_LARGE,
			message: `${label} keyframe count cannot exceed ${MAX_KEYFRAMES_PER_ITEM}`,
			retryable: false,
			status: 413,
			shotId: ids.shotId,
			itemId: ids.itemId,
		});
	}

	const seen = new Set<number>();
	for (const frame of frames) {
		if (
			!Number.isInteger(frame) ||
			frame < 0 ||
			frame >= durationInFrames
		) {
			throw domainInvariant(
				`${label} keyframe frame must lie inside the duration`,
				ids,
			);
		}

		if (seen.has(frame)) {
			throw domainInvariant(`${label} keyframe frame ${frame} is duplicated`, ids);
		}

		seen.add(frame);
	}
};

export const assertLoopWindow = (
	animation: {
		loop?: string;
		loopStartFrame?: number;
		loopEndFrame?: number;
	},
	label: string,
	ids: MotionIds,
): void => {
	if (animation.loop === undefined || animation.loop === 'none') {
		return;
	}

	if (animation.loop !== 'repeat' && animation.loop !== 'ping-pong') {
		throw domainInvariant(`${label} loop is invalid`, ids);
	}

	if (
		animation.loopStartFrame === undefined ||
		animation.loopEndFrame === undefined ||
		!Number.isInteger(animation.loopStartFrame) ||
		!Number.isInteger(animation.loopEndFrame) ||
		animation.loopEndFrame < animation.loopStartFrame
	) {
		throw domainInvariant(`${label} loop window is invalid`, ids);
	}
};
