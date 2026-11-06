import {describe, expect, it} from 'vitest';
import type {Shot} from '../../comic/types';
import type {TransformAnimation} from '../../motion/types';
import {
	appendTransformKeyframe,
	clearShotCameraMotion,
	initialTransformAnimation,
	removeTransformKeyframe,
	setTransformLoop,
	updateTransformKeyframe,
	writeShotCameraMotion,
} from './motion-controls-helpers';

describe('motion controls helpers', () => {
	it('creates an initial transform animation', () => {
		expect(initialTransformAnimation()).toEqual({
			keyframes: [{frame: 0}],
		});
	});

	it('appends a sorted keyframe within the item duration', () => {
		const animation: TransformAnimation = {
			keyframes: [{frame: 0}, {frame: 3}],
		};

		expect(
			appendTransformKeyframe({
				animation,
				durationInFrames: 5,
			}).keyframes,
		).toEqual([{frame: 0}, {frame: 3}, {frame: 4, easing: 'linear'}]);
	});

	it('does not append a duplicate keyframe when the timeline is full', () => {
		const animation: TransformAnimation = {
			keyframes: [{frame: 0}, {frame: 4}],
		};

		expect(
			appendTransformKeyframe({
				animation,
				durationInFrames: 5,
			}),
		).toBe(animation);
	});

	it('clamps edited keyframe frames between neighboring keyframes', () => {
		const animation: TransformAnimation = {
			keyframes: [{frame: 0}, {frame: 10}, {frame: 20}],
		};

		const movedLeft = updateTransformKeyframe({
			animation,
			index: 1,
			patch: {frame: -100},
			durationInFrames: 30,
		});
		expect(movedLeft.keyframes[1]?.frame).toBe(1);

		const movedRight = updateTransformKeyframe({
			animation,
			index: 1,
			patch: {frame: 100},
			durationInFrames: 30,
		});
		expect(movedRight.keyframes[1]?.frame).toBe(19);
	});

	it('marks edited transform properties as animated', () => {
		const animation = updateTransformKeyframe({
			animation: {keyframes: [{frame: 0}]},
			index: 0,
			patch: {x: 12, y: 8, opacity: 0.5},
			durationInFrames: 30,
		});
		expect(animation.animatedProperties).toEqual(['position', 'opacity']);
	});

	it('removes keyframes and returns null when removing the last keyframe', () => {
		expect(
			removeTransformKeyframe({
				animation: {keyframes: [{frame: 0}, {frame: 12}]},
				index: 0,
			}),
		).toEqual({keyframes: [{frame: 12}]});

		expect(
			removeTransformKeyframe({
				animation: {keyframes: [{frame: 0}]},
				index: 0,
			}),
		).toBeNull();
	});

	it('sets and clears transform loop metadata', () => {
		const looped = setTransformLoop({
			animation: {keyframes: [{frame: 0}, {frame: 100}]},
			loop: 'ping-pong',
			durationInFrames: 30,
		});

		expect(looped).toMatchObject({
			loop: 'ping-pong',
			loopStartFrame: 0,
			loopEndFrame: 29,
		});

		expect(
			setTransformLoop({
				animation: looped,
				loop: 'none',
				durationInFrames: 30,
			}),
		).toEqual({keyframes: [{frame: 0}, {frame: 100}]});
	});

	it('writes and clears shot camera motion without mutating other shots', () => {
		const shots: Shot[] = [
			{
				id: 'a',
				name: 'A',
				from: 0,
				durationInFrames: 30,
				layerTrackIds: [],
				dialogueItemIds: [],
			},
			{
				id: 'b',
				name: 'B',
				from: 30,
				durationInFrames: 30,
				layerTrackIds: [],
				dialogueItemIds: [],
			},
		];

		const cameraMotion = {
			keyframes: [
				{frame: 0, x: 0, y: 0, scale: 1},
				{frame: 29, x: 10, y: 0, scale: 1.1},
			],
		};
		const written = writeShotCameraMotion(shots, 'b', cameraMotion);
		expect(written[0]).toBe(shots[0]);
		expect(written[1]).toMatchObject({id: 'b', cameraMotion});

		const cleared = clearShotCameraMotion(written, 'b');
		expect(cleared[1]).not.toHaveProperty('cameraMotion');
	});
});
