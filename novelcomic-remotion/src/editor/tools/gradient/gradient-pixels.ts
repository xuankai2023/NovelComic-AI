import type {PixelBuffer} from '../../pixels/pixel-tools';
import type {ToolPoint} from '../types';
import type {GradientShape} from './gradient-settings';

export type GradientStop = {r: number; g: number; b: number; a: number};

export type GradientPaint = {
	/** Endpoints in the same space `at` returns. The ramp follows this segment. */
	start: ToolPoint;
	end: ToolPoint;
	shape: GradientShape;
	from: GradientStop;
	to: GradientStop;
	/** 0–1. Multiplies the stop alpha before it composites over the layer. */
	opacity: number;
	/**
	 * Document position of the layer pixel at column `x`, row `y`.
	 * Missing means the bitmap is the document, sampled at the pixel center.
	 */
	at?: (x: number, y: number) => ToolPoint | null;
	/** 0–1 coverage for the layer pixel whose top-left is (`x`, `y`). Missing means the whole layer. */
	coverage?: (x: number, y: number) => number;
};

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

/**
 * How far `point` is along the segment. 0 is the start stop, 1 is the end stop.
 * Past either end the ramp holds that stop, so a short drag does not stretch across the layer.
 */
export const gradientT = (point: ToolPoint, start: ToolPoint, end: ToolPoint, shape: GradientShape) => {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	if (shape === 'radial') {
		const length = Math.hypot(dx, dy);
		if (length < 1e-6) return 0;
		return Math.hypot(point.x - start.x, point.y - start.y) / length;
	}
	const length2 = dx * dx + dy * dy;
	if (length2 < 1e-8) return 0;
	return ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2;
};

const mix = (from: number, to: number, t: number) => from + (to - from) * t;

/** Source-over. A clear stop leaves the layer pixel. */
const composite = (
	base: readonly [number, number, number, number],
	sample: readonly [number, number, number, number],
	amount: number,
): [number, number, number, number] => {
	const as = (sample[3] / 255) * amount;
	if (as <= 0) return [base[0], base[1], base[2], base[3]];
	if (as >= 1 && sample[3] >= 255) return [sample[0], sample[1], sample[2], 255];
	const ab = base[3] / 255;
	const outA = as + ab * (1 - as);
	if (outA <= 0) return [0, 0, 0, 0];
	const channel = (index: number) => Math.round(((as * (sample[index] / 255) + ab * (base[index] / 255) * (1 - as)) / outA) * 255);
	return [channel(0), channel(1), channel(2), Math.round(outA * 255)];
};

/**
 * Paints the ramp through the layer. `at` places each pixel in the same space as the
 * endpoints, so a moved or rotated layer still follows the line. Returns the source
 * unchanged when the stops are missing.
 */
export const paintGradient = (source: PixelBuffer, paint: GradientPaint): PixelBuffer => {
	const data = new Uint8ClampedArray(source.data);
	const {start, end, shape, from, to, coverage} = paint;
	if (![start.x, start.y, end.x, end.y, paint.opacity].every(Number.isFinite)) return {width: source.width, height: source.height, data};
	const opacity = Math.min(1, Math.max(0, paint.opacity));
	if (opacity <= 0) return {width: source.width, height: source.height, data};
	for (let y = 0; y < source.height; y += 1) {
		for (let x = 0; x < source.width; x += 1) {
			const cover = coverage ? coverage(x, y) : 1;
			if (cover <= 0) continue;
			const point = paint.at ? paint.at(x, y) : {x: x + 0.5, y: y + 0.5};
			if (!point) continue;
			// Holds the nearer stop past either end, as Core Graphics does with drawsBeforeStartLocation.
			const t = Math.min(1, Math.max(0, gradientT(point, start, end, shape)));
			const sample: [number, number, number, number] = [
				clampByte(mix(from.r, to.r, t)),
				clampByte(mix(from.g, to.g, t)),
				clampByte(mix(from.b, to.b, t)),
				clampByte(mix(from.a, to.a, t)),
			];
			const blended = composite(
				[data[(y * source.width + x) * 4]!, data[(y * source.width + x) * 4 + 1]!, data[(y * source.width + x) * 4 + 2]!, data[(y * source.width + x) * 4 + 3]!],
				sample,
				opacity * cover,
			);
			const offset = (y * source.width + x) * 4;
			data[offset] = blended[0];
			data[offset + 1] = blended[1];
			data[offset + 2] = blended[2];
			data[offset + 3] = blended[3];
		}
	}
	return {width: source.width, height: source.height, data};
};
