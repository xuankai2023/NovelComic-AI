import type {Shot} from '../comic/types';
import type {ImageItem} from '../items/image/image-item-type';
import {evaluatePropertyGraph} from '../property/evaluate-property';
import {
	propertySetFromCamera,
	propertySetFromTransform,
} from '../property/migrate-motion';
import {PROPERTY_GRAPH_VERSION, propertySetId} from '../property/types';
import {
	type CameraAnimation,
	type EvaluatedImagePose,
	type TransformAnimation,
} from './types';

export type EvaluateImagePoseInput = {
	item: ImageItem;
	shot: Shot | null;
	globalFrame: number;
	compositionWidth: number;
	compositionHeight: number;
	fadeOpacity: number;
	previousShot?: Shot | null;
};

export type EvaluatedTransform = {
	x: number;
	y: number;
	scaleX: number;
	scaleY: number;
	rotation: number;
	opacity: number;
	anchorX: number;
	anchorY: number;
};

type TransformEvaluationCacheEntry = {
	signature: string;
	frames: Map<string, EvaluatedTransform>;
};

let transformEvaluationCache = new WeakMap<
	TransformAnimation,
	TransformEvaluationCacheEntry
>();

const TRANSFORM_DEFAULTS = {
	x: 0,
	y: 0,
	scaleX: 1,
	scaleY: 1,
	rotation: 0,
	opacity: 1,
} as const;

const clampUnit = (value: number): number => {
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}

	if (value >= 1) {
		return 1;
	}

	return value;
};

const readFinite = (value: number | undefined, fallback: number): number => {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const clampFrameToDuration = (
	frame: number,
	durationInFrames?: number,
): number => {
	const finiteFrame = Number.isFinite(frame) ? frame : 0;
	if (
		durationInFrames === undefined ||
		!Number.isFinite(durationInFrames) ||
		durationInFrames <= 0
	) {
		return finiteFrame;
	}

	return Math.max(0, Math.min(durationInFrames - 1, finiteFrame));
};

const transformAnimationSignature = (animation: TransformAnimation): string => {
	return JSON.stringify({
		animatedProperties: animation.animatedProperties,
		x: animation.x,
		y: animation.y,
		scaleX: animation.scaleX,
		scaleY: animation.scaleY,
		rotation: animation.rotation,
		opacity: animation.opacity,
		anchorX: animation.anchorX,
		anchorY: animation.anchorY,
		loop: animation.loop,
		loopStartFrame: animation.loopStartFrame,
		loopEndFrame: animation.loopEndFrame,
		keyframes: animation.keyframes,
	});
};

const evaluateTransformUncached = (
	animation: TransformAnimation | undefined,
	frame: number,
	durationInFrames?: number,
): EvaluatedTransform => {
	const owner = {kind: 'item', id: '__legacy-transform__'} as const;
	const set = propertySetFromTransform(owner, animation);
	const evaluated = evaluatePropertyGraph({
		graph: {
			version: PROPERTY_GRAPH_VERSION,
			sets: {[propertySetId(owner)]: set},
		},
		owner,
		frame,
		durationInFrames:
			durationInFrames && durationInFrames > 0
				? Math.floor(durationInFrames)
				: Math.max(
						1,
						Math.floor(frame) + 1,
						...set.properties.x.keyframes.map((keyframe) => keyframe.frame + 1),
					),
		validationMode: 'compatibility',
	});
	return {
		...evaluated,
		x: readFinite(evaluated.x, TRANSFORM_DEFAULTS.x),
		y: readFinite(evaluated.y, TRANSFORM_DEFAULTS.y),
		scaleX:
			Number.isFinite(evaluated.scaleX) && evaluated.scaleX > 0
				? evaluated.scaleX
				: TRANSFORM_DEFAULTS.scaleX,
		scaleY:
			Number.isFinite(evaluated.scaleY) && evaluated.scaleY > 0
				? evaluated.scaleY
				: TRANSFORM_DEFAULTS.scaleY,
		rotation: readFinite(evaluated.rotation, TRANSFORM_DEFAULTS.rotation),
		opacity: clampUnit(evaluated.opacity),
		anchorX: readFinite(evaluated.anchorX, 0.5),
		anchorY: readFinite(evaluated.anchorY, 0.5),
	};
};

export const clearTransformEvaluationCache = (): void => {
	transformEvaluationCache = new WeakMap();
};

export const evaluateTransformAtFrame = (
	animation: TransformAnimation | undefined,
	frame: number,
	options?: {durationInFrames?: number},
): EvaluatedTransform => {
	if (!animation) {
		return evaluateTransformUncached(
			undefined,
			frame,
			options?.durationInFrames,
		);
	}

	const signature = transformAnimationSignature(animation);
	let entry = transformEvaluationCache.get(animation);
	if (!entry || entry.signature !== signature) {
		entry = {signature, frames: new Map()};
		transformEvaluationCache.set(animation, entry);
	}

	const clampedFrame = clampFrameToDuration(frame, options?.durationInFrames);
	const cacheKey = `${clampedFrame}:${options?.durationInFrames ?? 'unbounded'}`;
	const cached = entry.frames.get(cacheKey);
	if (cached) {
		return {...cached};
	}

	const evaluated = evaluateTransformUncached(
		animation,
		clampedFrame,
		options?.durationInFrames,
	);
	entry.frames.set(cacheKey, evaluated);
	return {...evaluated};
};

const sampleCamera = (
	animation: CameraAnimation,
	frame: number,
	durationInFrames: number,
): {x: number; y: number; scale: number} => {
	const owner = {kind: 'shot', id: '__legacy-camera__'} as const;
	const set = propertySetFromCamera(owner, animation);
	const values = evaluatePropertyGraph({
		graph: {
			version: PROPERTY_GRAPH_VERSION,
			sets: {[propertySetId(owner)]: set},
		},
		owner,
		frame,
		durationInFrames,
		validationMode: 'compatibility',
	});
	return {x: values.x!, y: values.y!, scale: values.scale!};
};

const selectSpriteAssetId = (
	item: ImageItem,
	itemLocalFrame: number,
): string => {
	const spriteStates = item.motion?.spriteStates;
	if (!spriteStates || spriteStates.length === 0) {
		return item.assetId;
	}

	const ordered = [...spriteStates].sort(
		(left, right) => left.frame - right.frame,
	);
	let assetId = item.assetId;
	for (const sprite of ordered) {
		if (sprite.frame <= itemLocalFrame) {
			assetId = sprite.assetId;
		}
	}

	return assetId;
};

const crossfadeFactor = (
	shot: Shot | null,
	previousShot: Shot | null,
	globalFrame: number,
): number => {
	let factor = 1;

	if (shot?.transitionOut?.type === 'crossfade') {
		const duration = shot.transitionOut.durationInFrames;
		if (duration > 0) {
			const overlapStart = shot.from + shot.durationInFrames - duration;
			if (globalFrame >= overlapStart) {
				factor *= 1 - clampUnit((globalFrame - overlapStart) / duration);
			}
		}
	}

	if (previousShot?.transitionOut?.type === 'crossfade') {
		const duration = previousShot.transitionOut.durationInFrames;
		if (duration > 0) {
			const overlapStart =
				previousShot.from + previousShot.durationInFrames - duration;
			const overlapEnd = previousShot.from + previousShot.durationInFrames;
			if (globalFrame >= overlapStart && globalFrame < overlapEnd) {
				factor *= clampUnit((globalFrame - overlapStart) / duration);
			}
		}
	}

	return factor;
};

export const findPreviousCrossfadeShot = (
	shots: readonly Shot[],
	shot: Shot | null,
): Shot | null => {
	if (!shot) {
		return null;
	}

	let previous: Shot | null = null;
	for (const candidate of shots) {
		if (candidate.id === shot.id || candidate.from >= shot.from) {
			continue;
		}

		if (candidate.transitionOut?.type !== 'crossfade') {
			continue;
		}

		const end = candidate.from + candidate.durationInFrames;
		if (end <= shot.from) {
			continue;
		}

		if (!previous || candidate.from > previous.from) {
			previous = candidate;
		}
	}

	return previous;
};

export const evaluateImagePose = (
	input: EvaluateImagePoseInput,
): EvaluatedImagePose => {
	const {item, shot} = input;
	const itemLocalFrame = input.globalFrame - item.from;
	const transform = evaluateTransformAtFrame(
		item.motion?.transform,
		itemLocalFrame,
		{durationInFrames: item.durationInFrames},
	);
	const anchorX = transform.anchorX;
	const anchorY = transform.anchorY;

	let left =
		item.left + item.width * anchorX * (1 - transform.scaleX) + transform.x;
	let top =
		item.top + item.height * anchorY * (1 - transform.scaleY) + transform.y;
	let width = item.width * transform.scaleX;
	let height = item.height * transform.scaleY;

	if (shot?.cameraMotion) {
		const shotLocalFrame = input.globalFrame - shot.from;
		const camera = sampleCamera(
			shot.cameraMotion,
			shotLocalFrame,
			shot.durationInFrames,
		);
		const focalX = shot.cameraMotion.focalX ?? input.compositionWidth / 2;
		const focalY = shot.cameraMotion.focalY ?? input.compositionHeight / 2;
		left = focalX + (left - focalX) * camera.scale + camera.x;
		top = focalY + (top - focalY) * camera.scale + camera.y;
		width *= camera.scale;
		height *= camera.scale;
	}

	const fadeOpacity = Number.isFinite(input.fadeOpacity)
		? input.fadeOpacity
		: 1;
	const opacity = clampUnit(
		item.opacity *
			transform.opacity *
			fadeOpacity *
			crossfadeFactor(shot, input.previousShot ?? null, input.globalFrame),
	);

	return {
		assetId: selectSpriteAssetId(item, itemLocalFrame),
		left,
		top,
		width,
		height,
		rotation: item.rotation + transform.rotation,
		opacity,
		anchorX,
		anchorY,
	};
};
