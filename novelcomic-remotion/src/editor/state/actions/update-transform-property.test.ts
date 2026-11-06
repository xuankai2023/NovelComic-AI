import {describe, expect, it} from 'vitest';
import type {ImageItem} from '../../items/image/image-item-type';
import {evaluateTransformAtFrame} from '../../motion/evaluate';
import type {ImageMotion} from '../../motion/types';
import {getInitialState} from '../initial-state';
import {
	updateTransformPropertyCommand,
	updateTransformPropertyInState,
} from './update-transform-property';

const imageItem = (): ImageItem => ({
	id: 'image-1',
	type: 'image',
	assetId: 'asset-1',
	durationInFrames: 20,
	from: 10,
	top: 0,
	left: 0,
	width: 100,
	height: 100,
	opacity: 1,
	isDraggingInTimeline: false,
	borderRadius: 0,
	rotation: 0,
	keepAspectRatio: true,
	fadeInDurationInSeconds: 0,
	fadeOutDurationInSeconds: 0,
	cropLeft: 0,
	cropTop: 0,
	cropRight: 0,
	cropBottom: 0,
});

describe('updateTransformPropertyCommand', () => {
	it('writes the static transform fallback when Auto-Key is off and the property is not animated', () => {
		const motion: ImageMotion = {
			transform: {
				x: 0,
				y: 0,
				animatedProperties: [],
				keyframes: [],
			},
		};

		const result = updateTransformPropertyCommand({
			motion,
			property: 'position',
			frame: 12,
			durationInFrames: 30,
			values: [120, 80],
			autoKeyEnabled: false,
			mode: 'write',
		});

		expect(result.status).toBe('static');
		expect(result.motion.transform?.x).toBe(120);
		expect(result.motion.transform?.y).toBe(80);
		expect(result.motion.transform?.keyframes).toEqual([]);
	});

	it('blocks implicit keyframe creation for an animated property while Auto-Key is off', () => {
		const motion: ImageMotion = {
			transform: {
				x: 0,
				y: 0,
				animatedProperties: ['position'],
				keyframes: [],
			},
		};

		const result = updateTransformPropertyCommand({
			motion,
			property: 'position',
			frame: 12,
			durationInFrames: 30,
			values: [120, 80],
			autoKeyEnabled: false,
			mode: 'write',
		});

		expect(result).toMatchObject({
			motion,
			status: 'blocked',
			reason: 'animated-property',
			diagnostic: {code: 'ANIMATED_PROPERTY', property: 'position', frame: 12},
		});
	});

	it('uses the latest animation on consecutive writes instead of a stale frame result', () => {
		const initial: ImageMotion = {
			transform: {
				animatedProperties: ['position'],
				keyframes: [
					{frame: 0, x: 0, y: 0},
					{frame: 10, x: 10, y: 10},
				],
			},
		};
		const first = updateTransformPropertyCommand({
			motion: initial,
			property: 'position',
			frame: 5,
			durationInFrames: 20,
			values: [50, 60],
			autoKeyEnabled: true,
			mode: 'write',
		});
		expect(first.status).toBe('updated');
		const second = updateTransformPropertyCommand({
			motion: first.motion,
			property: 'position',
			frame: 5,
			durationInFrames: 20,
			values: [70, 80],
			autoKeyEnabled: true,
			mode: 'write',
		});

		expect(evaluateTransformAtFrame(second.motion.transform, 5)).toMatchObject({
			x: 70,
			y: 80,
		});
		expect(
			second.motion.transform?.keyframes.filter(({frame}) => frame === 5),
		).toHaveLength(1);
	});

	it('blocks locked and invalid edits without changing motion', () => {
		const motion: ImageMotion = {transform: {keyframes: []}};
		expect(
			updateTransformPropertyCommand({
				motion,
				itemId: 'image-locked',
				property: 'position',
				frame: 1,
				durationInFrames: 10,
				values: [2, 3],
				mode: 'write',
				locked: true,
			}),
		).toMatchObject({
			status: 'blocked',
			diagnostic: {code: 'TRACK_LOCKED', itemId: 'image-locked'},
		});
		const invalid = updateTransformPropertyCommand({
			motion,
			itemId: 'image-invalid',
			property: 'position',
			frame: Number.NaN,
			durationInFrames: 10,
			values: [2, 3],
			mode: 'write',
		});
		expect(invalid).toMatchObject({
			status: 'blocked',
			diagnostic: {code: 'FRAME_INVALID'},
		});
		expect(invalid.motion).toBe(motion);
	});

	it('rechecks the latest state and preserves identity for blocked operations', () => {
		const state = getInitialState();
		const item = imageItem();
		state.undoableState = {
			...state.undoableState,
			items: {[item.id]: item},
			tracks: [
				{
					id: 'track-1',
					items: [item.id],
					hidden: false,
					muted: false,
					locked: true,
				},
			],
		};
		const locked = updateTransformPropertyInState({
			state,
			itemId: item.id,
			globalFrame: 12,
			property: 'position',
			values: [5, 6],
			mode: 'write',
		});
		expect(locked).toMatchObject({
			status: 'blocked',
			diagnostic: {code: 'TRACK_LOCKED'},
		});
		expect(locked.state).toBe(state);

		state.undoableState.tracks[0] = {
			...state.undoableState.tracks[0]!,
			locked: false,
			hidden: true,
		};
		const hidden = updateTransformPropertyInState({
			state,
			itemId: item.id,
			globalFrame: 12,
			property: 'position',
			values: [5, 6],
			mode: 'write',
		});
		expect(hidden).toMatchObject({
			status: 'blocked',
			diagnostic: {code: 'TRACK_HIDDEN'},
		});
		expect(hidden.state).toBe(state);

		delete state.undoableState.items[item.id];
		const deleted = updateTransformPropertyInState({
			state,
			itemId: item.id,
			globalFrame: 12,
			property: 'position',
			values: [5, 6],
			mode: 'write',
		});
		expect(deleted).toMatchObject({
			status: 'blocked',
			diagnostic: {code: 'ITEM_NOT_FOUND'},
		});
		expect(deleted.state).toBe(state);
	});

	it.each([9, 30, -1, 10.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'blocks global frame %s without creating a new state',
		(globalFrame) => {
			const state = getInitialState();
			const item = imageItem();
			state.undoableState = {
				...state.undoableState,
				items: {[item.id]: item},
				tracks: [
					{id: 'track-1', items: [item.id], hidden: false, muted: false},
				],
			};
			const result = updateTransformPropertyInState({
				state,
				itemId: item.id,
				globalFrame,
				property: 'position',
				values: [5, 6],
				mode: 'write',
			});
			expect(result.status).toBe('blocked');
			expect(result.state).toBe(state);
		},
	);
});
