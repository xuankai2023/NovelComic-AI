import {describe, expect, it} from 'vitest';
import {sampleCurve} from './curve';

describe('motion curves', () => {
	it('preserves linear interpolation without handles', () => {
		expect(
			sampleCurve(
				[
					{frame: 0, value: 0},
					{frame: 10, value: 100},
				],
				5,
				0,
			),
		).toBe(50);
	});

	it('evaluates cubic handles deterministically', () => {
		const value = sampleCurve(
			[
				{frame: 0, value: 0, handleOut: {x: 0.1, y: 0}},
				{frame: 10, value: 100, handleIn: {x: 0.9, y: 1}},
			],
			5,
			0,
		);
		expect(value).toBeGreaterThan(0);
		expect(value).toBeLessThan(100);
		expect(sampleCurve(
			[
				{frame: 0, value: 0, handleOut: {x: 0.1, y: 0}},
				{frame: 10, value: 100, handleIn: {x: 0.9, y: 1}},
			],
			5,
			0,
		)).toBe(value);
	});

	it('holds the outgoing value until the next keyframe boundary', () => {
		const points = [
			{frame: 0, value: 10, hold: true},
			{frame: 10, value: 90},
		];

		expect(sampleCurve(points, 9.999, 0)).toBe(10);
		expect(sampleCurve(points, 10, 0)).toBe(90);
	});
});
