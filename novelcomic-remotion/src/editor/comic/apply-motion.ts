import type {ImageItem} from '../items/image/image-item-type';
import {
	CAMERA_PRESET_IDS,
	ITEM_PRESET_IDS,
	SPRITE_PRESET_IDS,
	expandCameraPreset,
	expandItemPreset,
	type CameraPresetId,
	type ItemPresetId,
} from '../motion/presets';
import type {
	CameraAnimation,
	CameraKeyframe,
	ImageMotion,
	TransformAnimation,
	TransformKeyframe,
} from '../motion/types';
import {
	writeItemTransformPropertySet,
	writeShotCameraPropertySet,
} from '../property/materialize-motion';
import type {UndoableState} from '../state/types';
import {assertLoopWindow, assertUniqueFrames} from './assert-motion';
import {assertFinalMotionTarget} from './assert-motion-target';
import {domainInvariant} from './errors';
import {cloneUndoableState} from './upsert-shot';

export type ApplyMotionMode = 'replace' | 'append';

export type ApplyMotionInput = {
	target:
		| {type: 'item'; itemId: string; presetId?: ItemPresetId | string}
		| {type: 'shot'; shotId: string; presetId?: CameraPresetId | string};
	mode: ApplyMotionMode;
	parameters?: Record<string, number | string | boolean>;
	seed?: number;
	keyframes?: TransformKeyframe[];
	cameraKeyframes?: CameraKeyframe[];
};

const includesId = (
	ids: readonly string[],
	value: string | undefined,
): boolean => {
	return value !== undefined && ids.includes(value);
};

const cloneTransformFrames = (
	keyframes: readonly TransformKeyframe[],
): TransformKeyframe[] => {
	return keyframes.map((keyframe) => {
		return {...keyframe};
	});
};

const cloneCameraFrames = (
	keyframes: readonly CameraKeyframe[],
): CameraKeyframe[] => {
	return keyframes.map((keyframe) => {
		return {...keyframe};
	});
};

const mergeFrames = <T extends {frame: number}>(
	existing: readonly T[],
	incoming: readonly T[],
	mode: ApplyMotionMode,
): T[] => {
	const frames = mode === 'append' ? [...existing, ...incoming] : [...incoming];
	return frames.sort((left, right) => left.frame - right.frame);
};

const requireImage = (project: UndoableState, itemId: string): ImageItem => {
	const item = project.items[itemId];
	if (!item) {
		throw domainInvariant(`Item ${itemId} does not exist`, {itemId});
	}

	if (item.type !== 'image') {
		throw domainInvariant(`Item ${itemId} is not an image`, {itemId});
	}

	const asset = project.assets[item.assetId];
	if (!asset || asset.type !== 'image') {
		throw domainInvariant(`Item ${itemId} references an invalid asset`, {
			itemId,
			assetId: item.assetId,
		});
	}

	for (const sprite of item.motion?.spriteStates ?? []) {
		const spriteAsset = project.assets[sprite.assetId];
		if (!spriteAsset || spriteAsset.type !== 'image') {
			throw domainInvariant(`Item ${itemId} references an invalid asset`, {
				itemId,
				assetId: sprite.assetId,
			});
		}
	}

	return item;
};

const writeItemMotion = (
	project: UndoableState,
	input: ApplyMotionInput & {target: {type: 'item'}},
): UndoableState => {
	if (input.cameraKeyframes && input.cameraKeyframes.length > 0) {
		throw domainInvariant('Camera keyframes cannot be written to an item', {
			itemId: input.target.itemId,
		});
	}

	const presetId = input.target.presetId;
	if (includesId(SPRITE_PRESET_IDS, presetId)) {
		throw domainInvariant(`${presetId} requires sprite state assets`, {
			itemId: input.target.itemId,
		});
	}

	if (
		presetId &&
		!includesId(ITEM_PRESET_IDS, presetId) &&
		includesId(CAMERA_PRESET_IDS, presetId)
	) {
		throw domainInvariant(`Preset ${presetId} does not apply to items`, {
			itemId: input.target.itemId,
		});
	}

	if (presetId && !includesId(ITEM_PRESET_IDS, presetId)) {
		throw domainInvariant(`Unknown motion preset: ${presetId}`, {
			itemId: input.target.itemId,
		});
	}

	const item = requireImage(project, input.target.itemId);
	assertFinalMotionTarget(project, item);
	const existing = item.motion?.transform;
	let incoming = input.keyframes
		? cloneTransformFrames(input.keyframes)
		: undefined;
	let expanded: TransformAnimation | undefined;
	if (presetId && includesId(ITEM_PRESET_IDS, presetId)) {
		expanded = expandItemPreset(presetId as ItemPresetId, {
			durationInFrames: item.durationInFrames,
			parameters: input.parameters,
			seed: input.seed,
		});
		if (!incoming) {
			incoming = cloneTransformFrames(expanded.keyframes);
		}
	}

	if (!incoming) {
		throw domainInvariant('Motion preset or keyframes are required', {
			itemId: item.id,
		});
	}

	const keyframes = mergeFrames(
		input.mode === 'append'
			? cloneTransformFrames(existing?.keyframes ?? [])
			: [],
		incoming,
		input.mode,
	);
	const transform: TransformAnimation = {
		...existing,
		...(expanded ?? {}),
		keyframes,
	};
	if (input.keyframes && !presetId) {
		delete transform.loop;
		delete transform.loopStartFrame;
		delete transform.loopEndFrame;
		if (existing?.loop) {
			transform.loop = existing.loop;
			transform.loopStartFrame = existing.loopStartFrame;
			transform.loopEndFrame = existing.loopEndFrame;
		}
	}

	assertLoopWindow(transform, 'Transform', {itemId: item.id});
	assertUniqueFrames(
		keyframes.map((keyframe) => keyframe.frame),
		item.durationInFrames,
		'Transform',
		{itemId: item.id},
	);

	const motion: ImageMotion = {
		...item.motion,
		transform,
	};
	if (presetId && includesId(ITEM_PRESET_IDS, presetId)) {
		motion.preset = {
			id: presetId,
			parameters: {...(input.parameters ?? {})},
		};
		if (input.seed !== undefined) {
			motion.preset.seed = input.seed;
		}
	} else if (input.keyframes) {
		delete motion.preset;
	}

	return {
		...project,
		items: {
			...project.items,
			[item.id]: {
				...item,
				motion,
			},
		},
	};
};

const writeShotMotion = (
	project: UndoableState,
	input: ApplyMotionInput & {target: {type: 'shot'}},
): UndoableState => {
	if (input.keyframes && input.keyframes.length > 0) {
		throw domainInvariant('Transform keyframes cannot be written to a shot', {
			shotId: input.target.shotId,
		});
	}

	const presetId = input.target.presetId;
	if (
		includesId(ITEM_PRESET_IDS, presetId) ||
		includesId(SPRITE_PRESET_IDS, presetId)
	) {
		throw domainInvariant(`Preset ${presetId} does not apply to shots`, {
			shotId: input.target.shotId,
		});
	}

	if (presetId && !includesId(CAMERA_PRESET_IDS, presetId)) {
		throw domainInvariant(`Unknown motion preset: ${presetId}`, {
			shotId: input.target.shotId,
		});
	}

	const shot = (project.shots ?? []).find((entry) => {
		return entry.id === input.target.shotId;
	});
	if (!shot) {
		throw domainInvariant(`Shot ${input.target.shotId} does not exist`, {
			shotId: input.target.shotId,
		});
	}

	const existing = shot.cameraMotion;
	let incoming = input.cameraKeyframes
		? cloneCameraFrames(input.cameraKeyframes)
		: undefined;
	let expanded: CameraAnimation | undefined;
	if (presetId && includesId(CAMERA_PRESET_IDS, presetId)) {
		expanded = expandCameraPreset(presetId as CameraPresetId, {
			durationInFrames: shot.durationInFrames,
			parameters: input.parameters,
			seed: input.seed,
		});
		if (!incoming) {
			incoming = cloneCameraFrames(expanded.keyframes);
		}
	}

	if (!incoming) {
		throw domainInvariant('Motion preset or keyframes are required', {
			shotId: shot.id,
		});
	}

	const keyframes = mergeFrames(
		input.mode === 'append' ? cloneCameraFrames(existing?.keyframes ?? []) : [],
		incoming,
		input.mode,
	);
	const cameraMotion: CameraAnimation = {
		...existing,
		...(expanded ?? {}),
		keyframes,
		focalX:
			existing?.focalX ?? expanded?.focalX ?? project.compositionWidth / 2,
		focalY:
			existing?.focalY ?? expanded?.focalY ?? project.compositionHeight / 2,
	};
	assertLoopWindow(cameraMotion, 'Camera', {shotId: shot.id});
	assertUniqueFrames(
		keyframes.map((keyframe) => keyframe.frame),
		shot.durationInFrames,
		'Camera',
		{shotId: shot.id},
	);

	return {
		...project,
		shots: (project.shots ?? []).map((entry) => {
			if (entry.id !== shot.id) {
				return entry;
			}

			return {
				...entry,
				cameraMotion,
			};
		}),
	};
};

export const applyMotion = (
	project: UndoableState,
	input: ApplyMotionInput,
): UndoableState => {
	const draft = cloneUndoableState(project);
	if (input.target.type === 'item') {
		const updated = writeItemMotion(draft, {...input, target: input.target});
		const item = updated.items[input.target.itemId];
		return writeItemTransformPropertySet(
			updated,
			input.target.itemId,
			item?.type === 'image' ? item.motion?.transform : undefined,
		);
	}

	const target = input.target;
	const updated = writeShotMotion(draft, {...input, target});
	return writeShotCameraPropertySet(
		updated,
		target.shotId,
		updated.shots?.find((shot) => shot.id === target.shotId)?.cameraMotion,
	);
};
