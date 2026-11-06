import {
	isTransformPropertyAnimated,
	type TransformTimelineProperty,
	type TransformTimelineValues,
	upsertTransformPropertyKeyframe,
} from './transform-property-timeline';
import type {TransformAnimation} from './types';

export type AutoKeyWriteResult =
	| {kind: 'static'}
	| {kind: 'keyframe'; animation: TransformAnimation}
	| {kind: 'blocked'; reason: 'animated-property' | 'outside-item'};

export const resolveAutoKeyTransformWrite = <
	Property extends TransformTimelineProperty,
>({
	animation,
	property,
	frame,
	durationInFrames,
	values,
	autoKeyEnabled,
}: {
	animation: TransformAnimation | undefined;
	property: Property;
	frame: number;
	durationInFrames: number;
	values: TransformTimelineValues[Property];
	autoKeyEnabled: boolean;
}): AutoKeyWriteResult => {
	if (!Number.isInteger(frame) || frame < 0 || frame >= durationInFrames) {
		return {kind: 'blocked', reason: 'outside-item'};
	}

	if (autoKeyEnabled) {
		return {
			kind: 'keyframe',
			animation: upsertTransformPropertyKeyframe({
				animation,
				property,
				frame,
				values,
			}),
		};
	}

	if (isTransformPropertyAnimated(animation, property)) {
		return {kind: 'blocked', reason: 'animated-property'};
	}

	return {kind: 'static'};
};
