import type {EditorStarterAsset} from '../assets/assets';
import type {ImageItem} from '../items/image/image-item-type';
import type {UndoableState} from '../state/types';
import {
	EASING_NAMES,
	TRANSFORM_ANIMATION_PROPERTIES,
	TRANSFORM_LOOPS,
	type TransformAnimationProperty,
} from './types';

export type MotionDiagnosticCode =
	| 'NO_SELECTION'
	| 'ITEM_NOT_FOUND'
	| 'NON_IMAGE_ITEM'
	| 'TRACK_LOCKED'
	| 'TRACK_HIDDEN'
	| 'LAYER_GROUP_LOCKED'
	| 'READ_ONLY'
	| 'FRAME_INVALID'
	| 'FRAME_OUTSIDE_ITEM'
	| 'MISSING_VALUES'
	| 'INVALID_VALUES'
	| 'INVALID_TRANSFORM'
	| 'DUPLICATE_KEYFRAME'
	| 'INVALID_KEYFRAME'
	| 'INVALID_LOOP'
	| 'INVALID_SPRITE'
	| 'MISSING_ASSET'
	| 'ASSET_UPLOAD_FAILED'
	| 'ASSET_NOT_READY'
	| 'ANIMATED_PROPERTY';

export type MotionDiagnostic = {
	code: MotionDiagnosticCode;
	message: string;
	repair: string;
	itemId?: string;
	property?: TransformAnimationProperty;
	frame?: number;
	assetId?: string;
};

export const validateTransformEditTarget = ({
	project,
	itemId,
}: {
	project: UndoableState;
	itemId: string | null | undefined;
}): MotionDiagnostic | null => {
	if (!itemId)
		return createMotionDiagnostic(
			'NO_SELECTION',
			'No Item is selected for Transform editing',
			'Select an image layer before editing Transform properties',
		);
	const item = project.items[itemId];
	if (!item)
		return createMotionDiagnostic(
			'ITEM_NOT_FOUND',
			`Item ${itemId} no longer exists`,
			'Refresh the selection or undo the deletion before editing',
			{itemId},
		);
	if (item.type !== 'image')
		return createMotionDiagnostic(
			'NON_IMAGE_ITEM',
			`Item ${itemId} is not an image layer`,
			'Select an image layer; this Transform timeline supports image layers only',
			{itemId},
		);
	const track = project.tracks.find((candidate) =>
		candidate.items.includes(itemId),
	);
	if (track?.locked)
		return createMotionDiagnostic(
			'TRACK_LOCKED',
			`Item ${itemId} is on locked Track ${track.id}`,
			'Unlock the Track before editing',
			{itemId},
		);
	if (track?.hidden)
		return createMotionDiagnostic(
			'TRACK_HIDDEN',
			`Item ${itemId} is on hidden Track ${track.id}`,
			'Show the Track before editing',
			{itemId},
		);
	const groups = project.layerGroups ?? {};
	let groupId = track
		? Object.values(groups).find((group) => group.trackIds.includes(track.id))
				?.id
		: undefined;
	while (groupId) {
		const group = groups[groupId];
		if (!group) break;
		if (group.locked)
			return createMotionDiagnostic(
				'LAYER_GROUP_LOCKED',
				`Item ${itemId} is in locked Layer Group ${group.id}`,
				'Unlock the Layer Group before editing',
				{itemId},
			);
		if (!group.visible)
			return createMotionDiagnostic(
				'TRACK_HIDDEN',
				`Item ${itemId} is in hidden Layer Group ${group.id}`,
				'Show the Layer Group before editing',
				{itemId},
			);
		groupId = group.parentGroupId;
	}
	return null;
};

export const createMotionDiagnostic = (
	code: MotionDiagnosticCode,
	message: string,
	repair: string,
	context: Omit<MotionDiagnostic, 'code' | 'message' | 'repair'> = {},
): MotionDiagnostic => ({code, message, repair, ...context});

const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const propertyKeys = [
	'anchorX',
	'anchorY',
	'x',
	'y',
	'scaleX',
	'scaleY',
	'rotation',
	'opacity',
] as const;

const timelineProperty = (
	property: (typeof propertyKeys)[number],
): TransformAnimationProperty => {
	if (property === 'anchorX' || property === 'anchorY') return 'anchorPoint';
	if (property === 'x' || property === 'y') return 'position';
	if (property === 'scaleX' || property === 'scaleY') return 'scale';
	return property;
};

const validateNumericProperty = ({
	value,
	property,
	itemId,
	frame,
	issues,
}: {
	value: unknown;
	property: (typeof propertyKeys)[number];
	itemId?: string;
	frame?: number;
	issues: MotionDiagnostic[];
}) => {
	if (value === undefined) return;
	const owner = itemId ?? 'unknown';
	const resolvedProperty = timelineProperty(property);
	const location = frame === undefined ? '' : ` at frame ${frame}`;
	if (!finite(value)) {
		issues.push(
			createMotionDiagnostic(
				'INVALID_TRANSFORM',
				`Item ${owner} has non-finite ${property}${location}`,
				`Replace ${resolvedProperty} with a finite number before preview or render`,
				{itemId, property: resolvedProperty, frame},
			),
		);
		return;
	}
	if ((property === 'scaleX' || property === 'scaleY') && value <= 0) {
		issues.push(
			createMotionDiagnostic(
				'INVALID_VALUES',
				`Item ${owner} has non-positive ${property}${location}`,
				'Set Scale to a positive value',
				{itemId, property: 'scale', frame},
			),
		);
	}
	if (property === 'opacity' && (value < 0 || value > 1)) {
		issues.push(
			createMotionDiagnostic(
				'INVALID_VALUES',
				`Item ${owner} has Opacity outside [0,1]${location}`,
				'Set Opacity between 0% and 100%',
				{itemId, property: 'opacity', frame},
			),
		);
	}
};

const validHandle = (value: unknown): boolean => {
	if (!isRecord(value)) return false;
	return (
		finite(value.x) &&
		finite(value.y) &&
		value.x >= 0 &&
		value.x <= 1 &&
		value.y >= -1 &&
		value.y <= 2
	);
};

export const validateTransformAnimation = ({
	animation,
	itemId,
	durationInFrames,
}: {
	animation: unknown;
	itemId?: string;
	durationInFrames?: number;
}): MotionDiagnostic[] => {
	if (animation === undefined) return [];
	if (!isRecord(animation)) {
		return [
			createMotionDiagnostic(
				'INVALID_TRANSFORM',
				`Item ${itemId ?? 'unknown'} Transform is not an object`,
				'Reset Transform data and recreate its animation',
				{itemId},
			),
		];
	}

	const issues: MotionDiagnostic[] = [];
	for (const property of propertyKeys) {
		validateNumericProperty({
			value: animation[property],
			property,
			itemId,
			issues,
		});
	}

	if (animation.animatedProperties !== undefined) {
		if (!Array.isArray(animation.animatedProperties)) {
			issues.push(
				createMotionDiagnostic(
					'INVALID_TRANSFORM',
					`Item ${itemId ?? 'unknown'} animatedProperties is not an array`,
					'Reset the Transform property stopwatches',
					{itemId},
				),
			);
		} else {
			const seen = new Set<unknown>();
			for (const property of animation.animatedProperties) {
				if (
					typeof property !== 'string' ||
					!(TRANSFORM_ANIMATION_PROPERTIES as readonly string[]).includes(
						property,
					) ||
					seen.has(property)
				) {
					issues.push(
						createMotionDiagnostic(
							'INVALID_TRANSFORM',
							`Item ${itemId ?? 'unknown'} has invalid or duplicate animated property ${String(property)}`,
							'Reset the affected Transform property stopwatch',
							{itemId},
						),
					);
				}
				seen.add(property);
			}
		}
	}

	const loop = animation.loop ?? 'none';
	if (!(TRANSFORM_LOOPS as readonly unknown[]).includes(loop)) {
		issues.push(
			createMotionDiagnostic(
				'INVALID_LOOP',
				`Item ${itemId ?? 'unknown'} has invalid Transform loop ${String(loop)}`,
				'Choose none, repeat, or ping-pong',
				{itemId},
			),
		);
	} else if (loop !== 'none') {
		const start = animation.loopStartFrame;
		const end = animation.loopEndFrame;
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			(start as number) < 0 ||
			(end as number) < (start as number) ||
			(durationInFrames !== undefined && (end as number) >= durationInFrames)
		) {
			issues.push(
				createMotionDiagnostic(
					'INVALID_LOOP',
					`Item ${itemId ?? 'unknown'} has an invalid loop frame range`,
					'Set integer loop endpoints inside the Item range',
					{itemId},
				),
			);
		}
	} else if (
		animation.loopStartFrame !== undefined ||
		animation.loopEndFrame !== undefined
	) {
		issues.push(
			createMotionDiagnostic(
				'INVALID_LOOP',
				`Item ${itemId ?? 'unknown'} has loop endpoints while looping is disabled`,
				'Clear the loop endpoints or enable a loop mode',
				{itemId},
			),
		);
	}

	if (!Array.isArray(animation.keyframes)) {
		issues.push(
			createMotionDiagnostic(
				'INVALID_TRANSFORM',
				`Item ${itemId ?? 'unknown'} Transform keyframes are missing or invalid`,
				'Reset keyframes to an empty array and recreate the animation',
				{itemId},
			),
		);
		return issues;
	}

	const seenFrames = new Set<number>();
	for (const [index, keyframe] of animation.keyframes.entries()) {
		if (!isRecord(keyframe)) {
			issues.push(
				createMotionDiagnostic(
					'INVALID_KEYFRAME',
					`Item ${itemId ?? 'unknown'} keyframe ${index} is malformed`,
					'Delete and recreate the malformed keyframe',
					{itemId},
				),
			);
			continue;
		}
		const frame = keyframe.frame;
		if (
			!Number.isInteger(frame) ||
			(frame as number) < 0 ||
			(durationInFrames !== undefined && (frame as number) >= durationInFrames)
		) {
			issues.push(
				createMotionDiagnostic(
					'INVALID_KEYFRAME',
					`Item ${itemId ?? 'unknown'} has a keyframe at invalid frame ${String(frame)}`,
					'Move the keyframe to an integer frame inside the Item range',
					{itemId, frame: finite(frame) ? frame : undefined},
				),
			);
		} else if (seenFrames.has(frame as number)) {
			issues.push(
				createMotionDiagnostic(
					'DUPLICATE_KEYFRAME',
					`Item ${itemId ?? 'unknown'} has duplicate keyframes at frame ${String(frame)}`,
					'Merge the duplicate entries into one keyframe',
					{itemId, frame: frame as number},
				),
			);
		}
		if (finite(frame)) seenFrames.add(frame);

		if (
			keyframe.easing !== undefined &&
			(typeof keyframe.easing !== 'string' ||
				!(EASING_NAMES as readonly string[]).includes(keyframe.easing))
		) {
			issues.push(
				createMotionDiagnostic(
					'INVALID_KEYFRAME',
					`Item ${itemId ?? 'unknown'} has invalid easing at frame ${String(frame)}`,
					'Choose a supported easing preset',
					{itemId, frame: finite(frame) ? frame : undefined},
				),
			);
		}
		if (keyframe.hold !== undefined && typeof keyframe.hold !== 'boolean') {
			issues.push(
				createMotionDiagnostic(
					'INVALID_KEYFRAME',
					`Item ${itemId ?? 'unknown'} has invalid hold data at frame ${String(frame)}`,
					'Reset the keyframe hold setting',
					{itemId, frame: finite(frame) ? frame : undefined},
				),
			);
		}
		for (const handleName of ['handleIn', 'handleOut'] as const) {
			if (
				keyframe[handleName] !== undefined &&
				!validHandle(keyframe[handleName])
			) {
				issues.push(
					createMotionDiagnostic(
						'INVALID_KEYFRAME',
						`Item ${itemId ?? 'unknown'} has invalid ${handleName} at frame ${String(frame)}`,
						'Reset the handle; x must be 0-1 and y must be -1 to 2',
						{itemId, frame: finite(frame) ? frame : undefined},
					),
				);
			}
		}
		for (const property of propertyKeys) {
			validateNumericProperty({
				value: keyframe[property],
				property,
				itemId,
				frame: finite(frame) ? frame : undefined,
				issues,
			});
		}
	}
	return issues;
};

export const validateTransformValues = ({
	itemId,
	property,
	values,
}: {
	itemId?: string;
	property: TransformAnimationProperty;
	values: readonly number[] | undefined;
}): MotionDiagnostic | null => {
	if (!values) {
		return createMotionDiagnostic(
			'MISSING_VALUES',
			`Item ${itemId ?? 'unknown'} has no ${property} values`,
			'Provide the current evaluated property values',
			{itemId, property},
		);
	}
	if (values.some((value) => !finite(value))) {
		return createMotionDiagnostic(
			'INVALID_VALUES',
			`Item ${itemId ?? 'unknown'} has invalid ${property} values`,
			'Enter finite values before committing the edit',
			{itemId, property},
		);
	}
	if (property === 'scale' && values.some((value) => value <= 0)) {
		return createMotionDiagnostic(
			'INVALID_VALUES',
			`Item ${itemId ?? 'unknown'} has non-positive Scale values`,
			'Set Scale to a positive value',
			{itemId, property},
		);
	}
	if (property === 'opacity' && (values[0]! < 0 || values[0]! > 1)) {
		return createMotionDiagnostic(
			'INVALID_VALUES',
			`Item ${itemId ?? 'unknown'} has Opacity outside [0,1]`,
			'Set Opacity between 0% and 100%',
			{itemId, property},
		);
	}
	return null;
};

export const validateEditFrame = ({
	itemId,
	frame,
	durationInFrames,
}: {
	itemId?: string;
	frame: number;
	durationInFrames: number;
}): MotionDiagnostic | null => {
	if (!Number.isInteger(frame) || !Number.isFinite(frame)) {
		return createMotionDiagnostic(
			'FRAME_INVALID',
			`Item ${itemId ?? 'unknown'} frame ${String(frame)} is not a finite integer`,
			'Move the playhead to an integer frame',
			{itemId, frame: Number.isFinite(frame) ? frame : undefined},
		);
	}
	if (!Number.isInteger(durationInFrames) || durationInFrames < 1) {
		return createMotionDiagnostic(
			'FRAME_OUTSIDE_ITEM',
			`Item ${itemId ?? 'unknown'} has invalid duration ${String(durationInFrames)}`,
			'Repair the Item duration before editing animation',
			{itemId, frame},
		);
	}
	if (frame < 0 || frame >= durationInFrames) {
		return createMotionDiagnostic(
			'FRAME_OUTSIDE_ITEM',
			`Item ${itemId ?? 'unknown'} frame ${frame} is outside its range`,
			'Move the playhead inside the Item range',
			{itemId, frame},
		);
	}
	return null;
};

export const validateSpriteReferences = ({
	item,
	assets,
}: {
	item: ImageItem;
	assets: Record<string, EditorStarterAsset>;
}): MotionDiagnostic[] => {
	const spriteIds = new Set([
		...(item.spriteAssetIds ?? []),
		...(item.motion?.spriteStates ?? []).map((state) => state.assetId),
	]);
	const issues: MotionDiagnostic[] = [];
	for (const assetId of new Set([item.assetId, ...spriteIds])) {
		const asset = assets[assetId];
		if (!asset) {
			issues.push(
				createMotionDiagnostic(
					'MISSING_ASSET',
					`Item ${item.id} references missing Asset ${assetId}`,
					'Restore or re-link the Asset before preview or render',
					{itemId: item.id, assetId},
				),
			);
			continue;
		}
		if (asset.type !== 'image') {
			issues.push(
				createMotionDiagnostic(
					'INVALID_SPRITE',
					`Item ${item.id} ${spriteIds.has(assetId) ? 'Sprite ' : ''}Asset ${assetId} is not an image`,
					'Use an image Asset for image and Sprite references',
					{itemId: item.id, assetId},
				),
			);
		}
		if (asset.remoteUrl === null || asset.remoteUrl === '') {
			issues.push(
				createMotionDiagnostic(
					'ASSET_NOT_READY',
					`Asset ${assetId} for Item ${item.id} is not uploaded`,
					'Wait for upload completion or retry the upload',
					{itemId: item.id, assetId},
				),
			);
		}
	}
	return issues;
};
