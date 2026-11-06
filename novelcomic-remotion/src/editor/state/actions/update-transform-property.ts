import {resolveAutoKeyTransformWrite} from '../../motion/auto-key';
import {
	createMotionDiagnostic,
	validateEditFrame,
	validateTransformAnimation,
	validateTransformEditTarget,
	validateTransformValues,
	type MotionDiagnostic,
} from '../../motion/diagnostics';
import {
	disableTransformPropertyAnimation,
	isTransformPropertyAnimated,
	removeTransformPropertyKeyframe,
	upsertTransformPropertyKeyframe,
	type TransformTimelineProperty,
	type TransformTimelineValues,
} from '../../motion/transform-property-timeline';
import type {ImageMotion, TransformAnimation} from '../../motion/types';
import {writeItemTransformPropertySet} from '../../property/materialize-motion';
import type {EditorState} from '../types';

type Values = TransformTimelineValues[TransformTimelineProperty];

export type TransformPropertyCommandMode =
	| 'toggle-animation'
	| 'set-keyframe'
	| 'remove-keyframe'
	| 'write';

export type UpdateTransformPropertyCommandArgs = {
	motion: ImageMotion;
	property: TransformTimelineProperty;
	frame: number;
	durationInFrames: number;
	values?: Values;
	enabled?: boolean;
	autoKeyEnabled?: boolean;
	mode: TransformPropertyCommandMode;
	itemId?: string;
	locked?: boolean;
	hidden?: boolean;
	readOnly?: boolean;
	itemExists?: boolean;
	itemType?: string;
	layerGroupLocked?: boolean;
};

export type TransformPropertyBlockedReason =
	| 'animated-property'
	| 'missing-values'
	| 'invalid-values'
	| 'invalid-transform'
	| 'invalid-frame'
	| 'outside-item'
	| 'item-not-found'
	| 'non-image-item'
	| 'locked'
	| 'hidden'
	| 'read-only';

export type UpdateTransformPropertyCommandResult =
	| {motion: ImageMotion; status: 'updated' | 'static'}
	| {
			motion: ImageMotion;
			status: 'blocked';
			reason: TransformPropertyBlockedReason;
			diagnostic: MotionDiagnostic;
	  };

const withTransform = (
	motion: ImageMotion,
	transform: TransformAnimation | null,
): ImageMotion => {
	if (transform) {
		return {...motion, transform};
	}

	const next = {...motion};
	delete next.transform;
	return next;
};

const writeStaticTransformValue = ({
	motion,
	property,
	values,
}: {
	motion: ImageMotion;
	property: TransformTimelineProperty;
	values: Values;
}): ImageMotion => {
	const transform = {...(motion.transform ?? {keyframes: []})};

	switch (property) {
		case 'anchorPoint':
			transform.anchorX = values[0];
			transform.anchorY = values[1];
			break;
		case 'position':
			transform.x = values[0];
			transform.y = values[1];
			break;
		case 'scale':
			transform.scaleX = values[0];
			transform.scaleY = values[1];
			break;
		case 'rotation':
			transform.rotation = values[0];
			break;
		case 'opacity':
			transform.opacity = values[0];
			break;
	}

	return {...motion, transform};
};

export const updateTransformPropertyCommand = (
	args: UpdateTransformPropertyCommandArgs,
): UpdateTransformPropertyCommandResult => {
	const {
		motion,
		property,
		frame,
		durationInFrames,
		values,
		mode,
		autoKeyEnabled = false,
		itemId,
		locked = false,
		hidden = false,
		readOnly = false,
		itemExists = true,
		itemType = 'image',
		layerGroupLocked = false,
	} = args;

	const block = (
		reason: TransformPropertyBlockedReason,
		diagnostic: MotionDiagnostic,
	): UpdateTransformPropertyCommandResult => ({
		motion,
		status: 'blocked',
		reason,
		diagnostic,
	});

	if (!itemExists) {
		return block(
			'item-not-found',
			createMotionDiagnostic(
				'ITEM_NOT_FOUND',
				`Item ${itemId ?? 'unknown'} no longer exists`,
				'Reselect an existing Item before editing Transform',
				{itemId, property, frame},
			),
		);
	}
	if (itemType !== 'image') {
		return block(
			'non-image-item',
			createMotionDiagnostic(
				'NON_IMAGE_ITEM',
				`Item ${itemId ?? 'unknown'} is not an image layer`,
				'Select an image layer to edit property-level Transform',
				{itemId, property, frame},
			),
		);
	}
	if (locked || layerGroupLocked || hidden || readOnly) {
		const blockedDiagnostic =
			locked || layerGroupLocked
				? ({
						code: layerGroupLocked ? 'LAYER_GROUP_LOCKED' : 'TRACK_LOCKED',
						message: `Item ${itemId ?? 'unknown'} is locked and cannot be edited`,
						repair: 'Unlock the Track or Layer Group before editing',
						itemId,
						property,
						frame,
					} satisfies MotionDiagnostic)
				: hidden
					? ({
							code: 'TRACK_HIDDEN',
							message: `Item ${itemId ?? 'unknown'} is hidden and cannot be edited`,
							repair: 'Show the Track before editing',
							itemId,
							property,
							frame,
						} satisfies MotionDiagnostic)
					: ({
							code: 'READ_ONLY',
							message: `Item ${itemId ?? 'unknown'} is read-only`,
							repair: 'Switch to an editable project or duplicate the Item',
							itemId,
							property,
							frame,
						} satisfies MotionDiagnostic);
		return block(
			locked || layerGroupLocked ? 'locked' : hidden ? 'hidden' : 'read-only',
			blockedDiagnostic,
		);
	}

	const frameDiagnostic = validateEditFrame({
		itemId,
		frame,
		durationInFrames,
	});
	if (frameDiagnostic) {
		return block(
			frameDiagnostic.code === 'FRAME_INVALID'
				? 'invalid-frame'
				: 'outside-item',
			frameDiagnostic,
		);
	}
	const transformIssues = validateTransformAnimation({
		animation: motion.transform,
		itemId,
		durationInFrames,
	});
	if (transformIssues.length > 0) {
		return block('invalid-transform', transformIssues[0]!);
	}

	if (mode === 'remove-keyframe') {
		return {
			motion: motion.transform
				? withTransform(
						motion,
						removeTransformPropertyKeyframe({
							animation: motion.transform,
							property,
							frame,
							values: values as never,
						}),
					)
				: motion,
			status: 'updated',
		};
	}

	if (!values) {
		return block(
			'missing-values',
			validateTransformValues({itemId, property, values})!,
		);
	}
	const valueDiagnostic = validateTransformValues({itemId, property, values});
	if (valueDiagnostic) return block('invalid-values', valueDiagnostic);

	if (mode === 'toggle-animation') {
		const enabled =
			args.enabled ?? !isTransformPropertyAnimated(motion.transform, property);
		if (enabled) {
			return {
				motion: withTransform(
					motion,
					upsertTransformPropertyKeyframe({
						animation: motion.transform,
						property,
						frame,
						values: values as never,
					}),
				),
				status: 'updated',
			};
		}

		return {
			motion: motion.transform
				? withTransform(
						motion,
						disableTransformPropertyAnimation({
							animation: motion.transform,
							property,
							values: values as never,
						}),
					)
				: motion,
			status: 'updated',
		};
	}

	if (mode === 'set-keyframe') {
		return {
			motion: withTransform(
				motion,
				upsertTransformPropertyKeyframe({
					animation: motion.transform,
					property,
					frame,
					values: values as never,
				}),
			),
			status: 'updated',
		};
	}

	const write = resolveAutoKeyTransformWrite({
		animation: motion.transform,
		property,
		frame,
		durationInFrames,
		values: values as never,
		autoKeyEnabled,
	});
	if (write.kind === 'blocked') {
		return block(
			write.reason,
			write.reason === 'animated-property'
				? ({
						code: 'ANIMATED_PROPERTY',
						message: `Item ${itemId ?? 'unknown'} ${property} is animated while Auto-Key is off`,
						repair: 'Enable Auto-Key or edit the property keyframe directly',
						itemId,
						property,
						frame,
					} satisfies MotionDiagnostic)
				: createMotionDiagnostic(
						'FRAME_OUTSIDE_ITEM',
						`Item ${itemId ?? 'unknown'} frame ${frame} is outside its range`,
						'Move the playhead inside the Item range',
						{itemId, property, frame},
					),
		);
	}
	if (write.kind === 'static') {
		return {
			motion: writeStaticTransformValue({motion, property, values}),
			status: 'static',
		};
	}

	return {
		motion: withTransform(motion, write.animation),
		status: 'updated',
	};
};

export type UpdateTransformPropertyInStateArgs = Omit<
	UpdateTransformPropertyCommandArgs,
	| 'motion'
	| 'frame'
	| 'durationInFrames'
	| 'itemId'
	| 'itemExists'
	| 'itemType'
	| 'locked'
	| 'hidden'
	| 'layerGroupLocked'
> & {
	state: EditorState;
	itemId: string | null | undefined;
	globalFrame: number;
};

export type UpdateTransformPropertyInStateResult =
	| {
			state: EditorState;
			status: 'updated' | 'static';
	  }
	| {
			state: EditorState;
			status: 'blocked';
			reason: TransformPropertyBlockedReason;
			diagnostic: MotionDiagnostic;
	  };

export const updateTransformPropertyInState = (
	args: UpdateTransformPropertyInStateArgs,
): UpdateTransformPropertyInStateResult => {
	const targetDiagnostic = validateTransformEditTarget({
		project: args.state.undoableState,
		itemId: args.itemId,
	});
	if (targetDiagnostic) {
		const reason: TransformPropertyBlockedReason =
			targetDiagnostic.code === 'ITEM_NOT_FOUND' ||
			targetDiagnostic.code === 'NO_SELECTION'
				? 'item-not-found'
				: targetDiagnostic.code === 'NON_IMAGE_ITEM'
					? 'non-image-item'
					: targetDiagnostic.code === 'TRACK_HIDDEN'
						? 'hidden'
						: 'locked';
		return {
			state: args.state,
			status: 'blocked',
			reason,
			diagnostic: targetDiagnostic,
		};
	}

	const item = args.state.undoableState.items[args.itemId!];
	if (!item || item.type !== 'image') {
		throw new Error('Transform target changed after validation');
	}
	const result = updateTransformPropertyCommand({
		motion: item.motion ?? {},
		property: args.property,
		frame: args.globalFrame - item.from,
		durationInFrames: item.durationInFrames,
		values: args.values,
		enabled: args.enabled,
		autoKeyEnabled: args.autoKeyEnabled,
		mode: args.mode,
		itemId: item.id,
		readOnly: args.readOnly,
	});
	if (result.status === 'blocked') {
		return {...result, state: args.state};
	}

	return {
		status: result.status,
		state: {
			...args.state,
			undoableState: writeItemTransformPropertySet(
				{
					...args.state.undoableState,
					items: {
						...args.state.undoableState.items,
						[item.id]: {...item, motion: result.motion},
					},
				},
				item.id,
				result.motion.transform,
			),
		},
	};
};
