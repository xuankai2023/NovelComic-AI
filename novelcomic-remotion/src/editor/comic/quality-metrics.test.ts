import {describe, expect, it} from 'vitest';
import {
	calculateAlphaHoleRatio,
	calculateRecompositionScore,
	inspectLayerQuality,
} from './quality-metrics';

const frame = (
	data: number[],
): {width: number; height: number; data: Uint8ClampedArray} => {
	return {width: 2, height: 1, data: new Uint8ClampedArray(data)};
};

describe('quality metrics', () => {
	it('reports transparent holes against opaque source pixels', () => {
		const source = frame([255, 0, 0, 255, 0, 255, 0, 255]);
		const recomposed = frame([255, 0, 0, 255, 0, 255, 0, 0]);

		expect(calculateAlphaHoleRatio(source, recomposed)).toBe(0.5);
		expect(calculateRecompositionScore(source, recomposed)).toBeCloseTo(
			0.125,
			5,
		);
	});

	it('returns zero for identical fully transparent frames', () => {
		const source = frame([255, 0, 0, 0, 0, 0, 0, 0]);
		expect(inspectLayerQuality(source, source)).toEqual({
			recompositionScore: 0,
			alphaHoleRatio: 0,
		});
	});
});
