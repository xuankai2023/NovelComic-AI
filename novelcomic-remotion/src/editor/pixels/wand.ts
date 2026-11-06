import type {PixelBuffer} from './pixel-tools';

/** Port of Compositor's `WandPixels.c`. Match is over premultiplied RGBA. */
const EAST = 1;
const SOUTH = 2;
const WEST = 4;
const NORTH = 8;
const EDGE_LIMIT = 8_000_000;

export type WandSampleSize = 'point' | 'three' | 'five';

export const wandSampleRadius = (size: WandSampleSize) => (size === 'five' ? 2 : size === 'three' ? 1 : 0);

export class WandError extends Error {
	constructor(readonly code: 'too-detailed' | 'memory') {
		super(
			code === 'too-detailed'
				? '这个选区太细，描不出边。换一个容差，或打开连续。'
				: '内存不够，无法建立这个选区。',
		);
	}
}

const matches = (rgba: Uint8ClampedArray | Uint8Array, offset: number, reference: readonly number[], tolerance: number) => {
	for (let channel = 0; channel < 4; channel++) {
		const delta = rgba[offset + channel]! - reference[channel]!;
		if (delta < -tolerance || delta > tolerance) return false;
	}
	return true;
};

/**
 * Pixels whose channels, alpha included, are within `tolerance` of the averaged seed.
 * Contiguous fills 4-connected from the seed and selects nothing when the seed itself
 * does not match. Returns the number selected, or -1 when the mask cannot be stored.
 */
export const wandMask = (
	rgba: Uint8ClampedArray | Uint8Array,
	width: number,
	height: number,
	stride: number,
	seedX: number,
	seedY: number,
	radius: number,
	tolerance: number,
	contiguous: boolean,
	mask: Uint8Array,
) => {
	if (!width || !height) return 0;
	mask.fill(0);
	if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return 0;
	const x0 = seedX > radius ? seedX - radius : 0;
	const x1 = seedX + radius < width ? seedX + radius : width - 1;
	const y0 = seedY > radius ? seedY - radius : 0;
	const y1 = seedY + radius < height ? seedY + radius : height - 1;
	const sums = [0, 0, 0, 0];
	let samples = 0;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++, samples++) {
			const offset = y * stride + x * 4;
			for (let channel = 0; channel < 4; channel++) sums[channel] += rgba[offset + channel]!;
		}
	}
	const half = Math.floor(samples / 2);
	const reference = sums.map((sum) => Math.floor((sum + half) / samples));
	let count = 0;
	if (!contiguous) {
		for (let y = 0; y < height; y++) {
			const row = y * stride;
			const out = y * width;
			for (let x = 0; x < width; x++) {
				if (!matches(rgba, row + x * 4, reference, tolerance)) continue;
				mask[out + x] = 255;
				count++;
			}
		}
		return count;
	}
	const stack = [seedX, seedY];
	let top = 1;
	while (top) {
		top--;
		const x = stack[top * 2]!;
		const y = stack[top * 2 + 1]!;
		const row = y * stride;
		const out = y * width;
		if (mask[out + x] || !matches(rgba, row + x * 4, reference, tolerance)) continue;
		let left = x;
		let right = x;
		while (left > 0 && !mask[out + left - 1] && matches(rgba, row + (left - 1) * 4, reference, tolerance)) left--;
		while (right + 1 < width && !mask[out + right + 1] && matches(rgba, row + (right + 1) * 4, reference, tolerance)) right++;
		mask.fill(255, out + left, out + right + 1);
		count += right - left + 1;
		for (let side = 0; side < 2; side++) {
			if (side === 0 ? y === 0 : y + 1 >= height) continue;
			const ny = side === 0 ? y - 1 : y + 1;
			const nrow = ny * stride;
			const nout = ny * width;
			let inRun = false;
			for (let nx = left; nx <= right; nx++) {
				const candidate = !mask[nout + nx] && matches(rgba, nrow + nx * 4, reference, tolerance);
				if (candidate && !inRun) {
					stack[top * 2] = nx;
					stack[top * 2 + 1] = ny;
					top++;
				}
				inRun = candidate;
			}
		}
	}
	return count;
};

const turnRight = (heading: number) => (heading === NORTH ? EAST : heading << 1);
const turnLeft = (heading: number) => (heading === EAST ? NORTH : heading >> 1);

/**
 * Closed loops of pixel corners. Outer boundaries run clockwise and holes
 * counterclockwise in top-left coordinates, so a nonzero winding fill covers
 * exactly the mask. -2 means the outline is too detailed to draw.
 */
export const wandTrace = (mask: Uint8Array, width: number, height: number) => {
	const loops: Array<Array<{x: number; y: number}>> = [];
	if (!width || !height) return {status: 0, loops};
	if (width >= 0x7fffffff || height >= 0x7fffffff) return {status: -1, loops};
	const stride = width + 1;
	const vertices = stride * (height + 1);
	let edges = 0;
	let out: Uint8Array;
	try {
		out = new Uint8Array(vertices);
	} catch {
		return {status: -1, loops};
	}
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			if (!mask[row + x]) continue;
			if (y === 0 || !mask[(y - 1) * width + x]) {
				out[y * stride + x] |= EAST;
				edges++;
			}
			if (x + 1 === width || !mask[row + x + 1]) {
				out[y * stride + x + 1] |= SOUTH;
				edges++;
			}
			if (y + 1 === height || !mask[(y + 1) * width + x]) {
				out[(y + 1) * stride + x + 1] |= WEST;
				edges++;
			}
			if (x === 0 || !mask[row + x - 1]) {
				out[(y + 1) * stride + x] |= NORTH;
				edges++;
			}
		}
		if (edges > EDGE_LIMIT) return {status: -2, loops};
	}
	const points: number[] = [];
	const lengths: number[] = [];
	for (let start = 0; start < vertices; start++) {
		while (out[start]) {
			const first = points.length / 2;
			let vertex = start;
			let heading = 0;
			let initial = 0;
			let steps = 0;
			do {
				if (++steps > edges + 2) return {status: -1, loops};
				const bits = out[vertex]!;
				let direction = 0;
				if (!heading) direction = bits & -bits;
				else if (bits & turnRight(heading)) direction = turnRight(heading);
				else if (bits & heading) direction = heading;
				else if (bits & turnLeft(heading)) direction = turnLeft(heading);
				else direction = bits & -bits;
				if (!direction) break;
				out[vertex] = (bits & ~direction) & 255;
				if (direction !== heading) points.push(vertex % stride, Math.floor(vertex / stride));
				if (!heading) initial = direction;
				heading = direction;
				vertex = direction === EAST ? vertex + 1 : direction === WEST ? vertex - 1 : direction === SOUTH ? vertex + stride : vertex - stride;
			} while (vertex !== start);
			if (heading === initial && points.length / 2 > first) points.splice(first * 2, 2);
			lengths.push(points.length / 2 - first);
		}
	}
	let index = 0;
	for (const length of lengths) {
		const loop: Array<{x: number; y: number}> = [];
		for (let corner = 0; corner < length; corner++) {
			loop.push({x: points[(index + corner) * 2]!, y: points[(index + corner) * 2 + 1]!});
		}
		index += length;
		if (loop.length >= 3) loops.push(loop);
	}
	return {status: 0, loops};
};

/**
 * The outline of pixels similar to `point`, in the image's top-left pixel coordinates.
 * Null when nothing matches or the point is outside the image.
 */
export const selectWand = (
	source: PixelBuffer,
	point: {x: number; y: number},
	settings: {tolerance: number; radius: number; contiguous: boolean},
) => {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
	const x = Math.floor(point.x);
	const y = Math.floor(point.y);
	if (x < 0 || y < 0 || x >= source.width || y >= source.height) return null;
	const mask = new Uint8Array(source.width * source.height);
	const count = wandMask(
		source.data,
		source.width,
		source.height,
		source.width * 4,
		x,
		y,
		Math.max(0, settings.radius),
		Math.max(0, Math.min(255, Math.round(settings.tolerance))),
		settings.contiguous,
		mask,
	);
	if (count < 0) throw new WandError('memory');
	if (count === 0) return null;
	const traced = wandTrace(mask, source.width, source.height);
	if (traced.status === -2) throw new WandError('too-detailed');
	if (traced.status !== 0) throw new WandError('memory');
	return traced.loops.length ? traced.loops : null;
};
