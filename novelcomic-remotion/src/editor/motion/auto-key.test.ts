import {describe, expect, it} from 'vitest';
import {resolveAutoKeyTransformWrite} from './auto-key';

describe('auto key transform writes', () => {
	it('keeps an unanimated property static while auto key is disabled', () => {
		expect(
			resolveAutoKeyTransformWrite({
				animation: undefined,
				property: 'position',
				frame: 8,
				durationInFrames: 30,
				values: [12, 24],
				autoKeyEnabled: false,
			}),
		).toEqual({kind: 'static'});
	});

	it('creates the first property keyframe only when auto key is enabled', () => {
		const result = resolveAutoKeyTransformWrite({
			animation: undefined,
			property: 'position',
			frame: 8,
			durationInFrames: 30,
			values: [12, 24],
			autoKeyEnabled: true,
		});

		expect(result.kind).toBe('keyframe');
		if (result.kind === 'keyframe') {
			expect(result.animation.animatedProperties).toContain('position');
			expect(result.animation.keyframes).toEqual([
				{frame: 8, easing: 'linear', x: 12, y: 24},
			]);
		}
	});

	it('blocks edits to animated properties while auto key is disabled', () => {
		expect(
			resolveAutoKeyTransformWrite({
				animation: {keyframes: [{frame: 0, x: 0, y: 0}]},
				property: 'position',
				frame: 8,
				durationInFrames: 30,
				values: [12, 24],
				autoKeyEnabled: false,
			}),
		).toEqual({kind: 'blocked', reason: 'animated-property'});
	});

	it('updates the current frame without creating a duplicate', () => {
		const result = resolveAutoKeyTransformWrite({
			animation: {keyframes: [{frame: 8, x: 1, y: 2}]},
			property: 'position',
			frame: 8,
			durationInFrames: 30,
			values: [12, 24],
			autoKeyEnabled: true,
		});

		expect(result.kind).toBe('keyframe');
		if (result.kind === 'keyframe') {
			expect(result.animation.keyframes).toEqual([{frame: 8, x: 12, y: 24}]);
		}
	});

	it('blocks writes outside the item local frame range', () => {
		expect(
			resolveAutoKeyTransformWrite({
				animation: undefined,
				property: 'position',
				frame: 30,
				durationInFrames: 30,
				values: [12, 24],
				autoKeyEnabled: true,
			}),
		).toEqual({kind: 'blocked', reason: 'outside-item'});
	});
});
