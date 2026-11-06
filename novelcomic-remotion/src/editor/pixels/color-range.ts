import type {PixelBuffer} from './pixel-tools';
import {wandTrace, WandError} from './wand';

/** Select > Color Range's preview fits in this, in points. The bitmap is twice that for a sharp picture. */
export const COLOR_RANGE_PREVIEW = {width: 292, height: 200};

const near = (rgb: readonly number[], colors: ArrayLike<number>, count: number, fuzziness: number) => {
	for (let index = 0; index < count; index++) {
		const offset = index * 3;
		if (
			Math.abs(rgb[0]! - colors[offset]!) <= fuzziness &&
			Math.abs(rgb[1]! - colors[offset + 1]!) <= fuzziness &&
			Math.abs(rgb[2]! - colors[offset + 2]!) <= fuzziness
		) {
			return true;
		}
	}
	return false;
};

/**
 * Port of `color_range_mask`. `rgba` is premultiplied. A pixel matches when its
 * straight color is within `fuzziness` of an included color and of no excluded one.
 * Transparent pixels match only when the range is inverted.
 */
export const colorRangeMask = (
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	stride: number,
	include: ArrayLike<number>,
	exclude: ArrayLike<number>,
	fuzziness: number,
	invert: boolean,
	mask: Uint8Array,
) => {
	const includeCount = Math.floor(include.length / 3);
	const excludeCount = Math.floor(exclude.length / 3);
	const tolerance = Math.max(0, Math.round(fuzziness));
	let count = 0;
	for (let y = 0; y < height; y++) {
		const row = y * stride;
		const out = y * width;
		for (let x = 0; x < width; x++) {
			const pixel = row + x * 4;
			const alpha = rgba[pixel + 3]!;
			let matches = false;
			if (alpha) {
				const half = Math.floor(alpha / 2);
				const rgb = [0, 1, 2].map((channel) => Math.floor((rgba[pixel + channel]! * 255 + half) / alpha));
				matches = near(rgb, include, includeCount, tolerance) && !near(rgb, exclude, excludeCount, tolerance);
			}
			if (invert) matches = !matches;
			mask[out + x] = matches ? 255 : 0;
			count += matches ? 1 : 0;
		}
	}
	return count;
};

/**
 * The straight color under `point`, averaged over the 3×3 around it.
 * Nil when the point is outside the image or the neighborhood is fully transparent.
 */
export const sampleColorRangeColor = (
	source: PixelBuffer,
	point: {x: number; y: number},
): [number, number, number] | null => {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
	const x = Math.floor(point.x);
	const y = Math.floor(point.y);
	if (x < 0 || y < 0 || x >= source.width || y >= source.height) return null;
	const sums = [0, 0, 0, 0];
	for (let row = 0; row < 3; row++) {
		for (let column = 0; column < 3; column++) {
			const px = x + column - 1;
			const py = y + row - 1;
			if (px < 0 || py < 0 || px >= source.width || py >= source.height) continue;
			const offset = (py * source.width + px) * 4;
			for (let channel = 0; channel < 4; channel++) sums[channel] += source.data[offset + channel]!;
		}
	}
	if (sums[3]! <= 0) return null;
	const half = Math.floor(sums[3]! / 2);
	return [0, 1, 2].map((channel) => Math.min(255, Math.floor((sums[channel]! * 255 + half) / sums[3]!))) as [
		number,
		number,
		number,
	];
};

/** Outline of the mask. Null when nothing is selected. Throws when the outline cannot be built. */
export const traceColorRange = (mask: Uint8Array, width: number, height: number) => {
	let selected = false;
	for (let index = 0; index < mask.length; index++) {
		if (mask[index]) {
			selected = true;
			break;
		}
	}
	if (!selected) return null;
	const traced = wandTrace(mask, width, height);
	if (traced.status === -2) throw new WandError('too-detailed');
	if (traced.status !== 0) throw new WandError('memory');
	return traced.loops.length ? traced.loops : null;
};

export const colorRangePreviewSize = (width: number, height: number) => {
	const scale = Math.min(COLOR_RANGE_PREVIEW.width / width, COLOR_RANGE_PREVIEW.height / height) * 2;
	return {
		width: Math.max(1, Math.trunc(width * scale)),
		height: Math.max(1, Math.trunc(height * scale)),
	};
};

/** The mask shrunk into the panel, white where selected. */
export const colorRangePreview = (mask: Uint8Array, width: number, height: number) => {
	const size = colorRangePreviewSize(width, height);
	const data = new Uint8Array(size.width * size.height);
	for (let y = 0; y < size.height; y++) {
		const sourceY = Math.min(height - 1, Math.floor(((y + 0.5) * height) / size.height));
		for (let x = 0; x < size.width; x++) {
			const sourceX = Math.min(width - 1, Math.floor(((x + 0.5) * width) / size.width));
			data[y * size.width + x] = mask[sourceY * width + sourceX]!;
		}
	}
	return {width: size.width, height: size.height, data};
};
