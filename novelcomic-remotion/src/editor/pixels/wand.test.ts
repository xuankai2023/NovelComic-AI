import {describe, expect, it} from 'vitest';
import {selectionCoverage, type SelectionShape} from '../document/selection-geometry';
import {createPixelBuffer, type PixelBuffer} from './pixel-tools';
import {selectWand, wandTrace} from './wand';

const red: [number, number, number, number] = [255, 0, 0, 255];
const blue: [number, number, number, number] = [0, 0, 255, 255];

const image = (width: number, height: number, color: (x: number, y: number) => [number, number, number, number]): PixelBuffer => {
	const buffer = createPixelBuffer(width, height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const pixel = color(x, y);
			buffer.data.set(pixel, (y * width + x) * 4);
		}
	}
	return buffer;
};

const pixels = (loops: Array<Array<{x: number; y: number}>> | null, width: number, height: number) => {
	if (!loops) return new Set<number>();
	const shape: SelectionShape = {kind: 'loops', loops};
	const selected = new Set<number>();
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (selectionCoverage(shape, x, y, {antialiased: false}) >= 128) selected.add(y * width + x);
		}
	}
	return selected;
};

const block = (columns: number[], rows: number[], width: number) =>
	new Set(rows.flatMap((y) => columns.map((x) => y * width + x)));

describe('magic wand mask', () => {
	it('stops at other colors when contiguous and finds every match when not', () => {
		const stripes = image(10, 4, (x) => (x < 3 || x >= 6 ? red : blue));
		const left = block([0, 1, 2], [0, 1, 2, 3], 10);
		const right = block([6, 7, 8, 9], [0, 1, 2, 3], 10);
		expect(pixels(selectWand(stripes, {x: 1.5, y: 2.5}, {tolerance: 32, radius: 0, contiguous: true}), 10, 4)).toEqual(left);
		expect(pixels(selectWand(stripes, {x: 1.5, y: 2.5}, {tolerance: 32, radius: 0, contiguous: false}), 10, 4)).toEqual(new Set([...left, ...right]));
		const banded = image(4, 3, (_x, y) => (y === 0 ? red : blue));
		expect(pixels(selectWand(banded, {x: 1, y: 0}, {tolerance: 32, radius: 0, contiguous: true}), 4, 3)).toEqual(new Set([0, 1, 2, 3]));
		expect(selectWand(banded, {x: 9, y: 0}, {tolerance: 32, radius: 0, contiguous: true})).toBeNull();
	});

	it('applies tolerance to every channel including alpha', () => {
		const columns: Array<[number, number, number, number]> = [
			[100, 100, 100, 255],
			[132, 100, 100, 255],
			[133, 100, 100, 255],
			[100, 100, 100, 222],
		];
		const row = image(4, 1, (x) => columns[x]!);
		const run = (tolerance: number) => pixels(selectWand(row, {x: 0.5, y: 0.5}, {tolerance, radius: 0, contiguous: false}), 4, 1);
		expect(run(0)).toEqual(new Set([0]));
		expect(run(32)).toEqual(new Set([0, 1]));
		expect(run(33)).toEqual(new Set([0, 1, 2, 3]));
	});

	it('averages the pixels around the click', () => {
		const dot = image(5, 5, (x, y) => (x === 2 && y === 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
		expect(pixels(selectWand(dot, {x: 2.5, y: 2.5}, {tolerance: 10, radius: 0, contiguous: false}), 5, 5)).toEqual(new Set([12]));
		const everywhere = new Set(Array.from({length: 25}, (_, index) => index));
		everywhere.delete(12);
		expect(pixels(selectWand(dot, {x: 2.5, y: 2.5}, {tolerance: 30, radius: 1, contiguous: false}), 5, 5)).toEqual(everywhere);
	});

	it('traces holes and pixels that only touch at a corner', () => {
		const width = 8;
		const height = 6;
		const mask = new Uint8Array(width * height);
		for (let y = 0; y < 3; y++) {
			for (let x = 0; x < 3; x++) {
				if (!(x === 1 && y === 1)) mask[y * width + x] = 255;
			}
		}
		mask[4 * width + 5] = 255;
		mask[5 * width + 6] = 255;
		const expected = new Set<number>();
		mask.forEach((value, index) => {
			if (value) expected.add(index);
		});
		expect(pixels(wandTrace(mask, width, height).loops, width, height)).toEqual(expected);
		expect(wandTrace(new Uint8Array(4), 2, 2).loops).toEqual([]);
	});
});
