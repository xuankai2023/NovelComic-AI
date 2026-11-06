import {describe, expect, it} from 'vitest';
import type {TransformAnimation} from './types';
import {
	disableTransformPropertyAnimation,
	findAdjacentTransformPropertyKeyframe,
	hasTransformPropertyKeyframeAt,
	isTransformPropertyAnimated,
	moveTransformPropertyKeyframe,
	removeTransformProperty,
	removeTransformPropertyKeyframe,
	upsertTransformPropertyKeyframe,
} from './transform-property-timeline';

describe('transform property timeline commands', () => {
	it('upserts one property without overwriting another property', () => {
		const position = upsertTransformPropertyKeyframe({
			animation: undefined,
			property: 'position',
			frame: 12,
			values: [20, 30],
		});
		const combined = upsertTransformPropertyKeyframe({
			animation: position,
			property: 'opacity',
			frame: 12,
			values: [0.5],
		});

		expect(combined.keyframes).toEqual([
			{frame: 12, easing: 'linear', x: 20, y: 30, opacity: 0.5},
		]);
		expect(isTransformPropertyAnimated(combined, 'position')).toBe(true);
		expect(hasTransformPropertyKeyframeAt(combined, 'opacity', 12)).toBe(true);
	});

	it('removes only the requested property and drops empty keyframes', () => {
		const animation: TransformAnimation = {
			keyframes: [
				{frame: 0, x: 0, y: 0, opacity: 1},
				{frame: 10, x: 10, y: 5},
			],
		};
		const withoutPositionAtTen = removeTransformPropertyKeyframe({
			animation,
			property: 'position',
			frame: 10,
		});
		expect(withoutPositionAtTen?.keyframes).toEqual([
			{frame: 0, x: 0, y: 0, opacity: 1},
		]);
		expect(
			removeTransformProperty({
				animation: withoutPositionAtTen!,
				property: 'position',
			})?.keyframes,
		).toEqual([{frame: 0, opacity: 1}]);
	});

	it('turns off an explicit stopwatch when its last keyframe is removed', () => {
		const animation: TransformAnimation = {
			animatedProperties: ['position', 'opacity'],
			keyframes: [{frame: 10, x: 10, y: 20, opacity: 0.5}],
		};
		const result = removeTransformPropertyKeyframe({
			animation,
			property: 'position',
			frame: 10,
			values: [10, 20],
		});
		expect(result?.animatedProperties).toEqual(['opacity']);
		expect(result?.keyframes).toEqual([{frame: 10, opacity: 0.5}]);
	});

	it('keeps the current value when disabling a stopwatch', () => {
		const disabled = disableTransformPropertyAnimation({
			animation: {
				keyframes: [
					{frame: 0, x: 0, y: 0},
					{frame: 10, x: 50, y: 20},
				],
			},
			property: 'position',
			values: [25, 10],
		});
		expect(disabled.keyframes).toEqual([]);
		expect(disabled.animatedProperties).toEqual([]);
		expect(disabled.x).toBe(25);
		expect(disabled.y).toBe(10);
	});

	it('moves one property while preserving other properties on shared frames', () => {
		const result = moveTransformPropertyKeyframe({
			animation: {
				keyframes: [
					{frame: 0, x: 10, y: 20, rotation: 5},
					{frame: 12, x: 40, y: 50},
				],
			},
			property: 'position',
			frame: 0,
			toFrame: 6,
			durationInFrames: 24,
		});

		expect(result.keyframes).toEqual([
			{frame: 0, rotation: 5},
			{frame: 6, easing: 'linear', x: 10, y: 20},
			{frame: 12, x: 40, y: 50},
		]);
	});

	it('clamps moved keyframes to the item duration', () => {
		const result = moveTransformPropertyKeyframe({
			animation: {keyframes: [{frame: 4, opacity: 0.5}]},
			property: 'opacity',
			frame: 4,
			toFrame: 99,
			durationInFrames: 10,
		});

		expect(result.keyframes[0]?.frame).toBe(9);
	});

	it('finds previous and next property keyframes', () => {
		const animation = {
			keyframes: [
				{frame: 0, rotation: 0},
				{frame: 8, opacity: 0.5},
				{frame: 16, rotation: 20},
			],
		};
		expect(
			findAdjacentTransformPropertyKeyframe({
				animation,
				property: 'rotation',
				frame: 12,
				direction: 'previous',
			}),
		).toBe(0);
		expect(
			findAdjacentTransformPropertyKeyframe({
				animation,
				property: 'rotation',
				frame: 12,
				direction: 'next',
			}),
		).toBe(16);
	});
});
