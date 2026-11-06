import {
	TRANSFORM_ANIMATION_PROPERTIES,
	type TransformAnimation,
	type TransformAnimationProperty,
	type TransformKeyframe,
} from './types';

export const TRANSFORM_TIMELINE_PROPERTIES = TRANSFORM_ANIMATION_PROPERTIES;

export type TransformTimelineProperty = TransformAnimationProperty;

export type TransformTimelineValues = {
	anchorPoint: [number, number];
	position: [number, number];
	scale: [number, number];
	rotation: [number];
	opacity: [number];
};

const propertyKeys: Record<
	TransformTimelineProperty,
	readonly (keyof TransformKeyframe)[]
> = {
	anchorPoint: ['anchorX', 'anchorY'],
	position: ['x', 'y'],
	scale: ['scaleX', 'scaleY'],
	rotation: ['rotation'],
	opacity: ['opacity'],
};

export const getTransformPropertyKeys = (property: TransformTimelineProperty) =>
	propertyKeys[property];

export const isTransformPropertyAnimated = (
	animation: TransformAnimation | undefined,
	property: TransformTimelineProperty,
): boolean => {
	if (animation?.animatedProperties) {
		return animation.animatedProperties.includes(property);
	}
	const keys = propertyKeys[property];
	return (animation?.keyframes ?? []).some((keyframe) =>
		keys.some((key) => typeof keyframe[key] === 'number'),
	);
};

const inferredAnimatedProperties = (
	animation: TransformAnimation | undefined,
): TransformTimelineProperty[] => {
	if (animation?.animatedProperties) {
		return animation.animatedProperties;
	}
	return TRANSFORM_TIMELINE_PROPERTIES.filter((property) => {
		const keys = propertyKeys[property];
		return (animation?.keyframes ?? []).some((keyframe) =>
			keys.some((key) => typeof keyframe[key] === 'number'),
		);
	});
};

export const getTransformPropertyKeyframes = (
	animation: TransformAnimation | undefined,
	property: TransformTimelineProperty,
): number[] => {
	const keys = propertyKeys[property];
	return (animation?.keyframes ?? [])
		.filter((keyframe) => keys.some((key) => typeof keyframe[key] === 'number'))
		.map((keyframe) => keyframe.frame)
		.sort((left, right) => left - right);
};

export const hasTransformPropertyKeyframeAt = (
	animation: TransformAnimation | undefined,
	property: TransformTimelineProperty,
	frame: number,
): boolean => {
	const keys = propertyKeys[property];
	const keyframe = animation?.keyframes.find((entry) => entry.frame === frame);
	return Boolean(
		keyframe && keys.every((key) => typeof keyframe[key] === 'number'),
	);
};

const valuesPatch = <Property extends TransformTimelineProperty>(
	property: Property,
	values: TransformTimelineValues[Property],
): Partial<TransformKeyframe> => {
	switch (property) {
		case 'anchorPoint':
			return {anchorX: values[0], anchorY: values[1]};
		case 'position':
			return {x: values[0], y: values[1]};
		case 'scale':
			return {scaleX: values[0], scaleY: values[1]};
		case 'rotation':
			return {rotation: values[0]};
		case 'opacity':
			return {opacity: values[0]};
	}
};

const staticValuesPatch = <Property extends TransformTimelineProperty>(
	property: Property,
	values: TransformTimelineValues[Property],
): Partial<TransformAnimation> => valuesPatch(property, values);

const isEmptyKeyframe = (keyframe: TransformKeyframe): boolean => {
	return ![
		'anchorX',
		'anchorY',
		'x',
		'y',
		'scaleX',
		'scaleY',
		'rotation',
		'opacity',
	].some((key) => typeof keyframe[key as keyof TransformKeyframe] === 'number');
};

export const upsertTransformPropertyKeyframe = <
	Property extends TransformTimelineProperty,
>({
	animation,
	property,
	frame,
	values,
}: {
	animation: TransformAnimation | undefined;
	property: Property;
	frame: number;
	values: TransformTimelineValues[Property];
}): TransformAnimation => {
	const patch = valuesPatch(property, values);
	const current = animation ?? {keyframes: []};
	const index = current.keyframes.findIndex((entry) => entry.frame === frame);
	const keyframes = [...current.keyframes];

	if (index === -1) {
		keyframes.push({frame, easing: 'linear', ...patch});
	} else {
		keyframes[index] = {...keyframes[index], ...patch};
	}

	return {
		...current,
		animatedProperties: Array.from(
			new Set([...inferredAnimatedProperties(current), property]),
		),
		keyframes: keyframes.sort((left, right) => left.frame - right.frame),
	};
};

export const removeTransformPropertyKeyframe = ({
	animation,
	property,
	frame,
	values,
}: {
	animation: TransformAnimation;
	property: TransformTimelineProperty;
	frame: number;
	values?: TransformTimelineValues[TransformTimelineProperty];
}): TransformAnimation | null => {
	const keys = propertyKeys[property];
	const keyframes = animation.keyframes
		.map((keyframe) => {
			if (keyframe.frame !== frame) {
				return keyframe;
			}
			const next = {...keyframe};
			for (const key of keys) {
				delete next[key];
			}
			return next;
		})
		.filter((keyframe) => !isEmptyKeyframe(keyframe));

	const hasPropertyKeyframe = keyframes.some((keyframe) =>
		keys.some((key) => typeof keyframe[key] === 'number'),
	);
	const animatedProperties = animation.animatedProperties
		? hasPropertyKeyframe
			? animation.animatedProperties
			: animation.animatedProperties.filter(
					(candidate) => candidate !== property,
				)
		: undefined;
	return {
		...animation,
		...(animatedProperties ? {animatedProperties} : {}),
		...(hasPropertyKeyframe || !values
			? {}
			: staticValuesPatch(property, values as never)),
		keyframes,
	};
};

export const removeTransformProperty = ({
	animation,
	property,
}: {
	animation: TransformAnimation;
	property: TransformTimelineProperty;
}): TransformAnimation | null => {
	const keys = propertyKeys[property];
	const keyframes = animation.keyframes
		.map((keyframe) => {
			const next = {...keyframe};
			for (const key of keys) {
				delete next[key];
			}
			return next;
		})
		.filter((keyframe) => !isEmptyKeyframe(keyframe));

	const animatedProperties = inferredAnimatedProperties(animation).filter(
		(candidate) => candidate !== property,
	);
	return {
		...animation,
		animatedProperties,
		keyframes,
	};
};

/** Move one property's keyframe without disturbing other properties sharing the frame. */
export const moveTransformPropertyKeyframe = ({
	animation,
	property,
	frame,
	toFrame,
	durationInFrames,
}: {
	animation: TransformAnimation;
	property: TransformTimelineProperty;
	frame: number;
	toFrame: number;
	durationInFrames: number;
}): TransformAnimation => {
	const source = animation.keyframes.find((keyframe) => keyframe.frame === frame);
	if (!source || frame === toFrame) {
		return animation;
	}

	const targetFrame = Math.max(0, Math.min(durationInFrames - 1, toFrame));
	const keys = propertyKeys[property];
	const patch = Object.fromEntries(
		keys.flatMap((key) =>
			typeof source[key] === 'number' ? [[key, source[key]]] : [],
		),
	) as Partial<TransformKeyframe>;
	if (Object.keys(patch).length === 0) {
		return animation;
	}

	const keyframes = animation.keyframes
		.map((keyframe) => {
			if (keyframe.frame !== frame) {
				return keyframe;
			}
			const next = {...keyframe};
			for (const key of keys) {
				delete next[key];
			}
			return next;
		})
		.filter((keyframe) => !isEmptyKeyframe(keyframe))
		.map((keyframe) =>
			keyframe.frame === targetFrame
				? {...keyframe, ...patch}
				: keyframe,
		);

	if (!keyframes.some((keyframe) => keyframe.frame === targetFrame)) {
		keyframes.push({frame: targetFrame, easing: source.easing ?? 'linear', ...patch});
	}

	return {
		...animation,
		keyframes: keyframes.sort((left, right) => left.frame - right.frame),
	};
};

export const disableTransformPropertyAnimation = <
	Property extends TransformTimelineProperty,
>({
	animation,
	property,
	values,
}: {
	animation: TransformAnimation;
	property: Property;
	values: TransformTimelineValues[Property];
}): TransformAnimation => {
	const withoutProperty = removeTransformProperty({animation, property});
	return {
		...(withoutProperty ?? {keyframes: []}),
		...staticValuesPatch(property, values),
	};
};

export const findAdjacentTransformPropertyKeyframe = ({
	animation,
	property,
	frame,
	direction,
}: {
	animation: TransformAnimation | undefined;
	property: TransformTimelineProperty;
	frame: number;
	direction: 'previous' | 'next';
}): number | null => {
	const frames = getTransformPropertyKeyframes(animation, property);
	if (direction === 'previous') {
		return [...frames].reverse().find((candidate) => candidate < frame) ?? null;
	}
	return frames.find((candidate) => candidate > frame) ?? null;
};
