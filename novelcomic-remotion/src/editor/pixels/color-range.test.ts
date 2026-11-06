import {describe, expect, it} from 'vitest';
import {createPixelBuffer} from './pixel-tools';
import {colorRangeMask, sampleColorRangeColor} from './color-range';

const fill = (width: number, height: number, color: (x: number, y: number) => [number, number, number, number]) => {
	const buffer = createPixelBuffer(width, height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) buffer.data.set(color(x, y), (y * width + x) * 4);
	}
	return buffer;
};

const selected = (
	buffer: ReturnType<typeof fill>,
	include: number[],
	exclude: number[] = [],
	fuzziness = 0,
	invert = false,
) => {
	const mask = new Uint8Array(buffer.width * buffer.height);
	colorRangeMask(buffer.data, buffer.width, buffer.height, buffer.width * 4, include, exclude, fuzziness, invert, mask);
	return [...mask].flatMap((value, index) => (value ? [index] : []));
};

describe('color range', () => {
	it('matches straight colors within fuzziness and keeps transparent pixels out', () => {
		const row = fill(4, 1, (x) => {
			if (x === 0) return [255, 0, 0, 255];
			if (x === 1) return [200, 0, 0, 255];
			if (x === 2) return [0, 0, 255, 255];
			return [0, 0, 0, 0];
		});
		expect(selected(row, [255, 0, 0])).toEqual([0]);
		expect(selected(row, [255, 0, 0], [], 55)).toEqual([0, 1]);
		expect(selected(row, [255, 0, 0], [255, 0, 0])).toEqual([]);
		expect(selected(row, [255, 0, 0], [], 0, true)).toEqual([1, 2, 3]);
	});

	it('unpremultiplies before comparing', () => {
		const pixel = fill(1, 1, () => [128, 0, 0, 128]);
		expect(selected(pixel, [255, 0, 0])).toEqual([0]);
		expect(selected(pixel, [128, 0, 0])).toEqual([]);
	});

	it('averages the 3×3 around the click and ignores a clear neighborhood', () => {
		const image = fill(3, 3, (x, y) => (x === 1 && y === 1 ? [128, 0, 0, 128] : [0, 0, 0, 0]));
		expect(sampleColorRangeColor(image, {x: 1.2, y: 1.2})).toEqual([255, 0, 0]);
		expect(sampleColorRangeColor(createPixelBuffer(2, 2), {x: 0.5, y: 0.5})).toBeNull();
		expect(sampleColorRangeColor(image, {x: -0.1, y: 1})).toBeNull();
	});
});
