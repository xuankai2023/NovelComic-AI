import {describe, expect, it} from 'vitest';
import {createCutoutPixels} from './create-cutout-asset';

const solidPixels = (width: number, height: number): Uint8ClampedArray => {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let index = 0; index < width * height; index++) {
		const offset = index * 4;
		data[offset] = 20 + (index % 10);
		data[offset + 1] = 80;
		data[offset + 2] = 160;
		data[offset + 3] = 255;
	}
	return data;
};

describe('createCutoutPixels', () => {
	it('keeps pixels inside a polygon and makes outside pixels transparent', () => {
		const result = createCutoutPixels({
			source: {
				width: 4,
				height: 4,
				data: solidPixels(4, 4),
			},
			polygon: [
				{x: 1, y: 1},
				{x: 3, y: 1},
				{x: 3, y: 3},
				{x: 1, y: 3},
			],
		});

		expect(result.bounds).toEqual({x: 1, y: 1, width: 2, height: 2});
		expect(result.cutout.width).toBe(2);
		expect(result.cutout.height).toBe(2);
		for (let index = 0; index < result.cutout.data.length; index += 4) {
			expect(result.cutout.data[index + 3]).toBe(255);
		}
		expect(result.mask.data[(1 * 4 + 1) * 4 + 3]).toBe(255);
		expect(result.mask.data[0]).toBe(0);
		expect(result.mask.data[(0 * 4 + 3) * 4]).toBe(0);
	});

	it('preserves source alpha inside the selected region', () => {
		const data = solidPixels(3, 3);
		data[4 * 4 + 3] = 96;

		const result = createCutoutPixels({
			source: {width: 3, height: 3, data},
			polygon: [
				{x: 0, y: 0},
				{x: 3, y: 0},
				{x: 3, y: 3},
				{x: 0, y: 3},
			],
		});

		expect(result.cutout.data[4 * 4 + 3]).toBe(96);
	});

	it('supports inversion while retaining source coordinates', () => {
		const result = createCutoutPixels({
			source: {
				width: 4,
				height: 4,
				data: solidPixels(4, 4),
			},
			polygon: [
				{x: 1, y: 1},
				{x: 3, y: 1},
				{x: 3, y: 3},
				{x: 1, y: 3},
			],
			options: {invert: true},
		});

		expect(result.bounds).toEqual({x: 0, y: 0, width: 4, height: 4});
		expect(result.cutout.data[0 * 4 + 3]).toBe(255);
		expect(result.cutout.data[(1 * 4 + 1) * 4 + 3]).toBe(0);
	});
});
