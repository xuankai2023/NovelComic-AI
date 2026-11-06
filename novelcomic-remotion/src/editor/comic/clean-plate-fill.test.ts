import {describe, expect, it} from 'vitest';
import {
	applyCloneFill,
	applyLocalInpaint,
	applySolidFill,
	fillCleanPlatePixels,
	parseCleanPlateColor,
	type CleanPlatePixels,
} from './clean-plate-fill';
import type {MaskPixels} from './rasterize-mask';

const pixels = (
	width: number,
	height: number,
	colors: readonly number[],
): CleanPlatePixels => {
	return {
		width,
		height,
		data: new Uint8ClampedArray(colors),
	};
};

const mask = (
	width: number,
	height: number,
	alpha: readonly number[],
): MaskPixels => {
	return {
		width,
		height,
		alpha: new Uint8ClampedArray(alpha),
	};
};

const pixelAt = (value: CleanPlatePixels, x: number, y: number) => {
	const offset = (y * value.width + x) * 4;
	return [...value.data.slice(offset, offset + 4)];
};

describe('clean plate local fills', () => {
	it('parses common fill color formats', () => {
		expect(parseCleanPlateColor('#0f8')).toEqual({
			r: 0,
			g: 255,
			b: 136,
			a: 255,
		});
		expect(parseCleanPlateColor('#11223380')).toEqual({
			r: 17,
			g: 34,
			b: 51,
			a: 128,
		});
		expect(parseCleanPlateColor('rgb(1, 2, 3)')).toEqual({
			r: 1,
			g: 2,
			b: 3,
			a: 255,
		});
	});

	it('changes only the masked pixels during solid fill', () => {
		const source = pixels(3, 1, [
			10, 20, 30, 255,
			40, 50, 60, 255,
			70, 80, 90, 255,
		]);
		const result = applySolidFill({
			source,
			mask: mask(3, 1, [0, 255, 128]),
			color: '#ff0000',
		});

		expect(pixelAt(result, 0, 0)).toEqual([10, 20, 30, 255]);
		expect(pixelAt(result, 1, 0)).toEqual([255, 0, 0, 255]);
		expect(pixelAt(result, 2, 0)).toEqual([163, 40, 45, 255]);
		expect(source.data).toEqual(
			new Uint8ClampedArray([
				10, 20, 30, 255,
				40, 50, 60, 255,
				70, 80, 90, 255,
			]),
		);
	});

	it('clones a source patch into the mask while preserving source coordinates', () => {
		const source = pixels(4, 2, [
			10, 0, 0, 255,
			20, 0, 0, 255,
			30, 0, 0, 255,
			40, 0, 0, 255,
			50, 0, 0, 255,
			60, 0, 0, 255,
			70, 0, 0, 255,
			80, 0, 0, 255,
		]);
		const result = applyCloneFill({
			source,
			mask: mask(4, 2, [0, 0, 255, 255, 0, 0, 255, 255]),
			clone: {
				source: {x: 0, y: 0},
				target: {x: 2, y: 0},
			},
		});

		expect(pixelAt(result, 0, 0)).toEqual([10, 0, 0, 255]);
		expect(pixelAt(result, 1, 0)).toEqual([20, 0, 0, 255]);
		expect(pixelAt(result, 2, 0)).toEqual([10, 0, 0, 255]);
		expect(pixelAt(result, 3, 0)).toEqual([20, 0, 0, 255]);
		expect(pixelAt(result, 2, 1)).toEqual([50, 0, 0, 255]);
		expect(pixelAt(result, 3, 1)).toEqual([60, 0, 0, 255]);
	});

	it('repairs a small hole from its known neighboring pixels', () => {
		const source = pixels(3, 3, [
			10, 10, 10, 255,
			10, 10, 10, 255,
			10, 10, 10, 255,
			10, 10, 10, 255,
			255, 0, 0, 255,
			10, 10, 10, 255,
			10, 10, 10, 255,
			10, 10, 10, 255,
			10, 10, 10, 255,
		]);
		const result = applyLocalInpaint({
			source,
			mask: mask(3, 3, [0, 0, 0, 0, 255, 0, 0, 0, 0]),
		});

		expect(result.applied).toBe(true);
		expect(pixelAt(result.pixels, 1, 1)).toEqual([10, 10, 10, 255]);
		expect(pixelAt(result.pixels, 0, 0)).toEqual([10, 10, 10, 255]);
	});

	it('returns the original image when the local inpaint region is too large', () => {
		const source = pixels(2, 1, [
			1, 2, 3, 255,
			4, 5, 6, 255,
		]);
		const result = fillCleanPlatePixels({
			source,
			mask: mask(2, 1, [255, 255]),
			mode: 'opencv-inpaint',
			maxInpaintPixels: 1,
		});

		expect(result.applied).toBe(false);
		expect(result.fellBack).toBe(true);
		expect(result.pixels.data).toEqual(source.data);
		expect(result.warnings[0]).toMatch(/exceeds 1 pixels/);
	});

	it('falls back without changing pixels when a fill request is invalid', () => {
		const source = pixels(1, 1, [1, 2, 3, 255]);
		const result = fillCleanPlatePixels({
			source,
			mask: mask(1, 1, [255]),
			mode: 'solid-fill',
		});

		expect(result.applied).toBe(false);
		expect(result.fellBack).toBe(true);
		expect(result.pixels.data).toEqual(source.data);
		expect(result.warnings).toContain('Solid fill requires a fill color');
	});
});
