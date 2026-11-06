import {describe, expect, it} from 'vitest';
import {validateTransformAnimation} from './diagnostics';
import {evaluateTransformAtFrame} from './evaluate';

describe('Transform diagnostics', () => {
	it('reports malformed keyframes without allowing non-finite evaluator output', () => {
		const animation = {
			scaleX: -1,
			opacity: 2,
			loop: 'repeat',
			loopStartFrame: 8,
			loopEndFrame: 80,
			keyframes: [
				{
					frame: 2,
					x: 1,
					easing: 'broken',
					hold: 'yes',
					handleOut: {x: 2, y: Number.NaN},
				},
				{frame: 2, x: Number.POSITIVE_INFINITY, scaleY: 0, opacity: -1},
			],
		} as const;
		const issues = validateTransformAnimation({
			animation,
			itemId: 'bad-image',
			durationInFrames: 20,
		});
		expect(issues.map(({code}) => code)).toEqual(
			expect.arrayContaining([
				'INVALID_VALUES',
				'INVALID_LOOP',
				'INVALID_KEYFRAME',
				'DUPLICATE_KEYFRAME',
				'INVALID_TRANSFORM',
			]),
		);
		expect(
			issues.every(
				({message, repair}) =>
					message.includes('bad-image') && repair.length > 0,
			),
		).toBe(true);

		const evaluated = evaluateTransformAtFrame(animation as never, 2, {
			durationInFrames: 20,
		});
		expect(Object.values(evaluated).every(Number.isFinite)).toBe(true);
		expect(evaluated.scaleX).toBeGreaterThan(0);
		expect(evaluated.scaleY).toBeGreaterThan(0);
		expect(evaluated.opacity).toBeGreaterThanOrEqual(0);
		expect(evaluated.opacity).toBeLessThanOrEqual(1);
	});

	it('reports missing keyframe storage instead of silently treating it as valid', () => {
		expect(
			validateTransformAnimation({
				animation: {x: 1},
				itemId: 'missing-keyframes',
			}),
		).toMatchObject([{code: 'INVALID_TRANSFORM', itemId: 'missing-keyframes'}]);
	});
});
