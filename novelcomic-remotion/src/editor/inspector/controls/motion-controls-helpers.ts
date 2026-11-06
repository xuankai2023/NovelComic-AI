import type {Shot} from '../../comic/types';
import type {
	CameraAnimation,
	TransformAnimation,
	TransformAnimationProperty,
	TransformKeyframe,
	TransformLoop,
} from '../../motion/types';

const transformPropertyForKey: Partial<
	Record<keyof TransformKeyframe, TransformAnimationProperty>
> = {
	anchorX: 'anchorPoint',
	anchorY: 'anchorPoint',
	x: 'position',
	y: 'position',
	scaleX: 'scale',
	scaleY: 'scale',
	rotation: 'rotation',
	opacity: 'opacity',
};

export const clampMotionValue = (
	value: number,
	min: number,
	max: number,
): number => {
	return Math.min(max, Math.max(min, value));
};

export const initialTransformAnimation = (): TransformAnimation => {
	return {
		keyframes: [{frame: 0}],
	};
};

export const updateTransformKeyframe = ({
	animation,
	index,
	patch,
	durationInFrames,
}: {
	animation: TransformAnimation;
	index: number;
	patch: Partial<TransformKeyframe>;
	durationInFrames: number;
}): TransformAnimation => {
	const patchedProperties = Object.keys(patch).flatMap((key) => {
		const property = transformPropertyForKey[key as keyof TransformKeyframe];
		return property ? [property] : [];
	});
	return {
		...animation,
		...(patchedProperties.length > 0
			? {
					animatedProperties: Array.from(
						new Set([
							...(animation.animatedProperties ?? []),
							...patchedProperties,
						]),
					),
				}
			: {}),
		keyframes: animation.keyframes.map((keyframe, keyframeIndex) => {
			if (keyframeIndex !== index) {
				return keyframe;
			}

			const next = {...keyframe, ...patch};
			if (patch.frame !== undefined) {
				const previous = animation.keyframes[index - 1]?.frame ?? -1;
				const following =
					animation.keyframes[index + 1]?.frame ?? durationInFrames;
				next.frame = clampMotionValue(
					Math.round(patch.frame),
					previous + 1,
					Math.min(durationInFrames - 1, following - 1),
				);
			}

			return next;
		}),
	};
};

export const appendTransformKeyframe = ({
	animation,
	durationInFrames,
}: {
	animation: TransformAnimation;
	durationInFrames: number;
}): TransformAnimation => {
	const lastFrame = animation.keyframes.at(-1)?.frame ?? -1;
	if (lastFrame >= durationInFrames - 1) {
		return animation;
	}

	const frame = Math.min(durationInFrames - 1, lastFrame + 1);

	return {
		...animation,
		keyframes: [
			...animation.keyframes,
			{frame, easing: 'linear' as const},
		].sort((left, right) => left.frame - right.frame),
	};
};

export const removeTransformKeyframe = ({
	animation,
	index,
}: {
	animation: TransformAnimation;
	index: number;
}): TransformAnimation | null => {
	if (animation.keyframes.length <= 1) {
		return null;
	}

	return {
		...animation,
		keyframes: animation.keyframes.filter((_, keyframeIndex) => {
			return keyframeIndex !== index;
		}),
	};
};

export const setTransformLoop = ({
	animation,
	loop,
	durationInFrames,
}: {
	animation: TransformAnimation;
	loop: TransformLoop;
	durationInFrames: number;
}): TransformAnimation => {
	if (loop === 'none') {
		const nextAnimation = {...animation};
		delete nextAnimation.loop;
		delete nextAnimation.loopStartFrame;
		delete nextAnimation.loopEndFrame;
		return nextAnimation;
	}

	const end =
		animation.loopEndFrame ??
		animation.keyframes.at(-1)?.frame ??
		durationInFrames - 1;

	return {
		...animation,
		loop,
		loopStartFrame: animation.loopStartFrame ?? 0,
		loopEndFrame: clampMotionValue(end, 0, durationInFrames - 1),
	};
};

export const writeShotCameraMotion = (
	shots: readonly Shot[],
	shotId: string,
	cameraMotion: CameraAnimation,
): Shot[] => {
	return shots.map((shot) => {
		if (shot.id !== shotId) {
			return shot;
		}

		return {
			...shot,
			cameraMotion,
		};
	});
};

export const clearShotCameraMotion = (
	shots: readonly Shot[],
	shotId: string,
): Shot[] => {
	return shots.map((shot) => {
		if (shot.id !== shotId) {
			return shot;
		}

		const next = {...shot};
		delete next.cameraMotion;
		return next;
	});
};
