import {describe, expect, it} from 'vitest';
import {createPixelBuffer} from '../../pixels/pixel-tools';
import {paintGradient, gradientT} from './gradient-pixels';
import {snapTo45} from './gradient-settings';

const pixel = (buffer: {width: number; data: Uint8ClampedArray}, x: number, y = 0) => {
	const offset = (y * buffer.width + x) * 4;
	return [buffer.data[offset], buffer.data[offset + 1], buffer.data[offset + 2], buffer.data[offset + 3]];
};

describe('gradient paint', () => {
	it('follows the dragged segment instead of stretching across the bitmap', () => {
		const source = createPixelBuffer(20, 1, [255, 0, 0, 255]);
		const painted = paintGradient(source, {
			start: {x: 0.5, y: 0.5},
			end: {x: 4.5, y: 0.5},
			shape: 'linear',
			from: {r: 255, g: 255, b: 255, a: 255},
			to: {r: 0, g: 0, b: 0, a: 255},
			opacity: 1,
		});
		expect(pixel(painted, 0)).toEqual([255, 255, 255, 255]);
		expect(pixel(painted, 2)).toEqual([128, 128, 128, 255]);
		expect(pixel(painted, 4)).toEqual([0, 0, 0, 255]);
		expect(pixel(painted, 12)).toEqual([0, 0, 0, 255]);
	});

	it('radiates from the start and stops at the end', () => {
		const source = createPixelBuffer(11, 1, [0, 0, 0, 0]);
		const painted = paintGradient(source, {
			start: {x: 0.5, y: 0.5},
			end: {x: 4.5, y: 0.5},
			shape: 'radial',
			from: {r: 0, g: 0, b: 0, a: 255},
			to: {r: 255, g: 255, b: 255, a: 255},
			opacity: 1,
		});
		expect(pixel(painted, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(painted, 2)[0]).toBe(128);
		expect(pixel(painted, 8)).toEqual([255, 255, 255, 255]);
	});

	it('fades the foreground to clear without tinting the transparent stop', () => {
		const source = createPixelBuffer(5, 1, [0, 0, 255, 255]);
		const painted = paintGradient(source, {
			start: {x: 0.5, y: 0.5},
			end: {x: 4.5, y: 0.5},
			shape: 'linear',
			from: {r: 255, g: 0, b: 0, a: 255},
			to: {r: 255, g: 0, b: 0, a: 0},
			opacity: 1,
		});
		expect(pixel(painted, 0)).toEqual([255, 0, 0, 255]);
		expect(pixel(painted, 4)).toEqual([0, 0, 255, 255]);
	});

	it('limits the ramp to the coverage mask', () => {
		const source = createPixelBuffer(6, 1, [0, 255, 0, 255]);
		const painted = paintGradient(source, {
			start: {x: 0.5, y: 0.5},
			end: {x: 5.5, y: 0.5},
			shape: 'linear',
			from: {r: 0, g: 0, b: 0, a: 255},
			to: {r: 0, g: 0, b: 0, a: 255},
			opacity: 1,
			coverage: (x) => (x < 3 ? 1 : 0),
		});
		expect(pixel(painted, 1)).toEqual([0, 0, 0, 255]);
		expect(pixel(painted, 4)).toEqual([0, 255, 0, 255]);
	});

	it('reads positions from at, so the ramp is not stuck to bitmap columns', () => {
		const source = createPixelBuffer(2, 1, [0, 0, 0, 0]);
		const painted = paintGradient(source, {
			start: {x: 0, y: 0},
			end: {x: 10, y: 0},
			shape: 'linear',
			from: {r: 0, g: 0, b: 0, a: 255},
			to: {r: 255, g: 255, b: 255, a: 255},
			opacity: 1,
			at: (x) => ({x: x === 0 ? 0 : 10, y: 0}),
		});
		expect(pixel(painted, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(painted, 1)).toEqual([255, 255, 255, 255]);
	});

	it('holds a missing segment at the start stop', () => {
		expect(gradientT({x: 3, y: 3}, {x: 1, y: 1}, {x: 1, y: 1}, 'linear')).toBe(0);
		expect(gradientT({x: 3, y: 1}, {x: 1, y: 1}, {x: 1, y: 1}, 'radial')).toBe(0);
	});
});

describe('snap to 45 degrees', () => {
	it('keeps the length and picks the nearest axis', () => {
		const snapped = snapTo45({x: 10, y: 10}, {x: 20, y: 11});
		expect(snapped.y).toBeCloseTo(10, 5);
		expect(snapped.x).toBeCloseTo(10 + Math.hypot(10, 1), 5);
	});
});
