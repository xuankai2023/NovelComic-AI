import {describe, expect, it} from 'vitest';
import {
	getPolygonBounds,
	pointInPolygon,
	rasterizePolygonMask,
} from './rasterize-mask';

describe('rasterizePolygonMask', () => {
	it('calculates a clamped integer crop bounds', () => {
		expect(
			getPolygonBounds(
				[
					{x: 1.2, y: 2.4},
					{x: 5.8, y: 2.4},
					{x: 4.1, y: 7.9},
				],
				{width: 8, height: 10},
			),
		).toEqual({x: 1, y: 2, width: 5, height: 6});
	});

	it('rasterizes polygon interiors and leaves the outside transparent', () => {
		const mask = rasterizePolygonMask(
			[
				{x: 1, y: 1},
				{x: 5, y: 1},
				{x: 5, y: 5},
				{x: 1, y: 5},
			],
			{width: 6, height: 6},
		);

		expect(mask.alpha[2 * 6 + 2]).toBe(255);
		expect(mask.alpha[0]).toBe(0);
		expect(mask.alpha[5 * 6 + 5]).toBe(0);
	});

	it('supports expansion, feathering, and inversion', () => {
		const expanded = rasterizePolygonMask(
			[
				{x: 2, y: 2},
				{x: 4, y: 2},
				{x: 4, y: 4},
				{x: 2, y: 4},
			],
			{width: 6, height: 6},
			{expandPixels: 1},
		);
		expect(expanded.alpha[1 * 6 + 2]).toBe(255);

		const feathered = rasterizePolygonMask(
			[
				{x: 1, y: 1},
				{x: 5, y: 1},
				{x: 5, y: 5},
				{x: 1, y: 5},
			],
			{width: 6, height: 6},
			{featherRadius: 1},
		);
		expect(feathered.alpha[2 * 6 + 2]).toBeGreaterThan(0);
		expect(feathered.alpha[0]).toBeLessThan(255);

		const inverted = rasterizePolygonMask(
			[
				{x: 1, y: 1},
				{x: 5, y: 1},
				{x: 5, y: 5},
				{x: 1, y: 5},
			],
			{width: 6, height: 6},
			{invert: true},
		);
		expect(inverted.alpha[0]).toBe(255);
		expect(inverted.alpha[2 * 6 + 2]).toBe(0);
	});

	it('rejects invalid polygons', () => {
		expect(() =>
			getPolygonBounds(
				[
					{x: 0, y: 0},
					{x: 1, y: 1},
				],
				{width: 4, height: 4},
			),
		).toThrow(/at least 3/);
		expect(
			pointInPolygon({x: 1, y: 1}, [
				{x: 0, y: 0},
				{x: 4, y: 0},
				{x: 4, y: 4},
				{x: 0, y: 4},
			]),
		).toBe(true);
	});
});
