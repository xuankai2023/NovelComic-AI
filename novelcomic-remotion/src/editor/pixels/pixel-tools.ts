/** CPU reference implementations for the Compositor pixel tools.
 * Every operation is immutable, deterministic and safe to move into a Worker.
 * Preview code may use a downsampled buffer; the same functions are used for
 * full-resolution export. */

import {healCoverage, healingModeIndex} from './heal-pixels';

export type PixelBuffer = {width: number; height: number; data: Uint8ClampedArray};
export type PixelPoint = {x: number; y: number; pressure?: number};
export type PixelSelection = {width: number; height: number; alpha: Uint8ClampedArray};
export type BrushOptions = {size: number; hardness?: number; opacity?: number; color?: [number, number, number, number]; healingMode?: 'content-aware' | 'create-texture' | 'proximity-match'; seed?: number};
export type GradientOptions = {start: [number, number, number, number]; end: [number, number, number, number]; mode?: 'linear' | 'radial'; angle?: number; opacity?: number};

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min = 0, max = 255) => Math.max(min, Math.min(max, finite(value)));
const unit = (value: number) => clamp(value, 0, 1);
const clone = (source: PixelBuffer): PixelBuffer => ({width: source.width, height: source.height, data: new Uint8ClampedArray(source.data)});
const offset = (x: number, y: number, width: number) => (y * width + x) * 4;
const inside = (x: number, y: number, source: PixelBuffer) => x >= 0 && y >= 0 && x < source.width && y < source.height;
const pixel = (source: PixelBuffer, x: number, y: number): [number, number, number, number] => {
	if (!inside(x, y, source)) return [0, 0, 0, 0];
	const i = offset(x, y, source.width); return [source.data[i]!, source.data[i + 1]!, source.data[i + 2]!, source.data[i + 3]!];
};
const write = (source: PixelBuffer, x: number, y: number, color: readonly number[]) => {
	if (!inside(x, y, source)) return;
	const i = offset(x, y, source.width); source.data[i] = clamp(color[0]!); source.data[i + 1] = clamp(color[1]!); source.data[i + 2] = clamp(color[2]!); source.data[i + 3] = clamp(color[3]!);
};
const coverage = (distance: number, radius: number, hardness: number) => {
	if (distance > radius) return 0;
	const edge = Math.max(0, Math.min(1, hardness));
	return distance <= radius * edge ? 1 : 1 - (distance / radius - edge) / Math.max(0.0001, 1 - edge);
};

export const createPixelBuffer = (width: number, height: number, fill: readonly number[] = [0, 0, 0, 0]): PixelBuffer => {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Pixel dimensions must be positive integers');
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) { data[i] = clamp(fill[0] ?? 0); data[i + 1] = clamp(fill[1] ?? 0); data[i + 2] = clamp(fill[2] ?? 0); data[i + 3] = clamp(fill[3] ?? 0); }
	return {width, height, data};
};

export const paintBrush = (source: PixelBuffer, points: readonly PixelPoint[], options: BrushOptions): PixelBuffer => {
	const result = clone(source); const radius = Math.max(0.5, finite(options.size, 1) / 2); const hardness = unit(options.hardness ?? 1); const opacity = unit(options.opacity ?? 1); const color = options.color ?? [0, 0, 0, 255];
	for (const point of points) {
		const cx = finite(point.x), cy = finite(point.y), strength = opacity * unit(point.pressure ?? 1);
		for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
			const amount = coverage(Math.hypot(x + .5 - cx, y + .5 - cy), radius, hardness) * strength; if (!amount || !inside(x, y, result)) continue;
			const before = pixel(result, x, y); const alpha = amount * (color[3] ?? 255) / 255;
			write(result, x, y, [before[0] + (color[0]! - before[0]) * alpha, before[1] + (color[1]! - before[1]) * alpha, before[2] + (color[2]! - before[2]) * alpha, before[3] + (255 - before[3]) * alpha]);
		}
	}
	return result;
};

export const eraseBrush = (source: PixelBuffer, points: readonly PixelPoint[], options: Omit<BrushOptions, 'color'>): PixelBuffer => {
	const result = clone(source); const radius = Math.max(.5, finite(options.size, 1) / 2); const hardness = unit(options.hardness ?? 1); const opacity = unit(options.opacity ?? 1);
	for (const point of points) for (let y = Math.floor(point.y - radius); y <= Math.ceil(point.y + radius); y++) for (let x = Math.floor(point.x - radius); x <= Math.ceil(point.x + radius); x++) {
		const amount = coverage(Math.hypot(x + .5 - point.x, y + .5 - point.y), radius, hardness) * opacity * unit(point.pressure ?? 1); if (!amount) continue; const p = pixel(result, x, y); write(result, x, y, [p[0], p[1], p[2], p[3] * (1 - amount)]);
	}
	return result;
};

export const boxBlur = (source: PixelBuffer, radius: number, selection?: PixelSelection): PixelBuffer => {
	const r = Math.max(0, Math.min(64, Math.floor(finite(radius)))); if (!r) return clone(source); const result = clone(source);
	for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
		const index = y * source.width + x; if (selection && !selection.alpha[index]) continue; let count = 0; const sum = [0, 0, 0, 0];
		for (let yy = Math.max(0, y - r); yy <= Math.min(source.height - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(source.width - 1, x + r); xx++) { const p = pixel(source, xx, yy); for (let c = 0; c < 4; c++) sum[c] += p[c]!; count++; }
		write(result, x, y, sum.map((value) => value / count));
	}
	return result;
};

export const smudgePixels = (source: PixelBuffer, points: readonly PixelPoint[], options: BrushOptions & {strength?: number; mode?: 'smudge' | 'liquify'}): PixelBuffer => {
	const result = clone(source); const radius = Math.max(1, finite(options.size, 8) / 2); const strength = unit(options.strength ?? options.opacity ?? .5); const mode = options.mode ?? 'smudge';
	for (let i = 0; i < points.length; i++) { const point = points[i]!; const previous = points[Math.max(0, i - 1)]!; const dx = point.x - previous.x, dy = point.y - previous.y; const sourceSnapshot = clone(result);
		for (let y = Math.floor(point.y - radius); y <= Math.ceil(point.y + radius); y++) for (let x = Math.floor(point.x - radius); x <= Math.ceil(point.x + radius); x++) { const amount = coverage(Math.hypot(x + .5 - point.x, y + .5 - point.y), radius, unit(options.hardness ?? .7)) * strength; if (!amount) continue; const sx = mode === 'liquify' ? x - dx * strength : x - dx; const sy = mode === 'liquify' ? y - dy * strength : y - dy; const sample = pixel(sourceSnapshot, Math.round(sx), Math.round(sy)); const before = pixel(result, x, y); write(result, x, y, before.map((value, c) => value + (sample[c]! - value) * amount)); }
	}
	return result;
};

export const cloneStamp = (source: PixelBuffer, sourcePoint: PixelPoint, targetPoints: readonly PixelPoint[], options: BrushOptions & {aligned?: boolean}): PixelBuffer => {
	const result = clone(source); const radius = Math.max(.5, finite(options.size, 20) / 2); const offsetX = targetPoints[0] ? sourcePoint.x - targetPoints[0].x : 0; const offsetY = targetPoints[0] ? sourcePoint.y - targetPoints[0].y : 0;
	for (const target of targetPoints) { for (let y = Math.floor(target.y - radius); y <= Math.ceil(target.y + radius); y++) for (let x = Math.floor(target.x - radius); x <= Math.ceil(target.x + radius); x++) { const amount = coverage(Math.hypot(x + .5 - target.x, y + .5 - target.y), radius, unit(options.hardness ?? 1)) * unit(options.opacity ?? 1); if (!amount) continue; const sourceX = Math.round(options.aligned === false ? sourcePoint.x : x + offsetX), sourceY = Math.round(options.aligned === false ? sourcePoint.y : y + offsetY); const sample = pixel(source, sourceX, sourceY); const before = pixel(result, x, y); write(result, x, y, before.map((value, c) => value + (sample[c]! - value) * amount)); } }
	return result;
};

/** One spot-healing stroke: coverage is accumulated, then Compositor's kernel runs once. */
export const spotHealing = (source: PixelBuffer, points: readonly PixelPoint[], options: BrushOptions): PixelBuffer => {
	const result = clone(source);
	const radius = Math.max(1, finite(options.size, 20) / 2);
	const hardness = unit(options.hardness ?? 1);
	const opacity = unit(options.opacity ?? 1);
	const gray = new Uint8Array(source.width * source.height);
	for (const point of points) {
		const cx = finite(point.x);
		const cy = finite(point.y);
		const pressure = unit(point.pressure ?? 1);
		for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
			for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
				if (!inside(x, y, result)) continue;
				const amount = coverage(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), radius, hardness) * pressure;
				if (amount <= 0) continue;
				const index = y * source.width + x;
				const dab = Math.round(amount * 255);
				const current = gray[index] ?? 0;
				gray[index] = hardness >= 1 ? Math.max(current, dab) : 255 - Math.round(((255 - current) * (255 - dab)) / 255);
			}
		}
	}
	const seed = options.seed === undefined ? 1 : options.seed >>> 0;
	healCoverage(result.data, gray, source.width, source.height, opacity, healingModeIndex(options.healingMode), seed);
	return result;
};

export const applyGradient = (source: PixelBuffer, options: GradientOptions, selection?: PixelSelection): PixelBuffer => {
	const result = clone(source); const angle = (options.angle ?? 0) * Math.PI / 180; const dx = Math.cos(angle), dy = Math.sin(angle); const opacity = unit(options.opacity ?? 1);
	for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) { const index = y * source.width + x; if (selection && !selection.alpha[index]) continue; let t = options.mode === 'radial' ? Math.hypot(x - source.width / 2, y - source.height / 2) / Math.hypot(source.width / 2, source.height / 2) : ((x - source.width / 2) * dx + (y - source.height / 2) * dy) / Math.hypot(source.width, source.height) + .5; t = unit(t); const color = options.start.map((value, c) => value + (options.end[c]! - value) * t); const before = pixel(result, x, y); const amount = opacity * (selection?.alpha[index] ?? 255) / 255; write(result, x, y, before.map((value, c) => value + (color[c]! - value) * amount)); }
	return result;
};

export const eyedropper = (source: PixelBuffer, point: PixelPoint, radius = 0): [number, number, number, number] => {
	const r = Math.max(0, Math.floor(radius)); const values: number[][] = []; for (let y = Math.floor(point.y) - r; y <= Math.floor(point.y) + r; y++) for (let x = Math.floor(point.x) - r; x <= Math.floor(point.x) + r; x++) if (inside(x, y, source)) values.push(pixel(source, x, y)); return [0, 1, 2, 3].map((c) => Math.round(values.reduce((sum, value) => sum + value[c]!, 0) / Math.max(1, values.length))) as [number, number, number, number];
};

const selection = (width: number, height: number, values?: ArrayLike<number>): PixelSelection => ({width, height, alpha: values ? Uint8ClampedArray.from(values) : new Uint8ClampedArray(width * height)});
const colorDistance = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
export const colorRangeSelection = (source: PixelBuffer, target: readonly [number, number, number], tolerance = 32): PixelSelection => { const alpha = new Uint8ClampedArray(source.width * source.height); for (let i = 0; i < alpha.length; i++) { const p = source.data.subarray(i * 4, i * 4 + 4); alpha[i] = p[3] === 0 ? 0 : Math.round(Math.max(0, 1 - colorDistance(p, target) / Math.max(1, tolerance)) * 255); } return selection(source.width, source.height, alpha); };
export const magicWandSelection = (source: PixelBuffer, start: PixelPoint, tolerance = 24): PixelSelection => { const x = Math.max(0, Math.min(source.width - 1, Math.floor(start.x))), y = Math.max(0, Math.min(source.height - 1, Math.floor(start.y))); const target = pixel(source, x, y); const alpha = new Uint8ClampedArray(source.width * source.height); const seen = new Uint8Array(alpha.length); const queue = [[x, y] as const]; for (let head = 0; head < queue.length; head++) { const [px, py] = queue[head]!; const i = py * source.width + px; if (seen[i]) continue; seen[i] = 1; const value = pixel(source, px, py); if (value[3] === 0 || colorDistance(value, target) > tolerance) continue; alpha[i] = 255; for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]] as const) if (inside(nx, ny, source)) queue.push([nx, ny]); } return selection(source.width, source.height, alpha); };
export const objectSelection = (source: PixelBuffer, bounds?: {x: number; y: number; width: number; height: number}): PixelSelection => { const alpha = new Uint8ClampedArray(source.width * source.height); const rect = bounds ?? {x: source.width * .2, y: source.height * .2, width: source.width * .6, height: source.height * .6}; for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(source.height, Math.ceil(rect.y + rect.height)); y++) for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(source.width, Math.ceil(rect.x + rect.width)); x++) if (pixel(source, x, y)[3] > 0) alpha[y * source.width + x] = 255; return selection(source.width, source.height, alpha); };
export const selectSubject = (source: PixelBuffer): PixelSelection => { const alpha = new Uint8ClampedArray(source.width * source.height); const visited = new Uint8Array(alpha.length); let best: number[] = []; for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) { const start = y * source.width + x; if (visited[start] || pixel(source, x, y)[3] < 16) continue; const component: number[] = []; const queue = [[x, y] as const]; for (let head = 0; head < queue.length; head++) { const [px, py] = queue[head]!; const i = py * source.width + px; if (visited[i] || pixel(source, px, py)[3] < 16) continue; visited[i] = 1; component.push(i); for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]] as const) if (inside(nx, ny, source)) queue.push([nx, ny]); } if (component.length > best.length) best = component; } best.forEach((i) => { alpha[i] = 255; }); return selection(source.width, source.height, alpha); };

export const selectionToMask = (value: PixelSelection): PixelBuffer => { const result = createPixelBuffer(value.width, value.height, [255, 255, 255, 0]); for (let i = 0; i < value.alpha.length; i++) result.data[i * 4 + 3] = value.alpha[i]!; return result; };
export const maskToSelection = (source: PixelBuffer): PixelSelection => selection(source.width, source.height, Array.from({length: source.width * source.height}, (_, i) => source.data[i * 4 + 3]!));
export const expandSelection = (value: PixelSelection, radius: number): PixelSelection => morphSelection(value, radius, true);
export const contractSelection = (value: PixelSelection, radius: number): PixelSelection => morphSelection(value, radius, false);
const morphSelection = (value: PixelSelection, radius: number, expand: boolean): PixelSelection => { const result = selection(value.width, value.height); const r = Math.max(0, Math.floor(radius)); for (let y = 0; y < value.height; y++) for (let x = 0; x < value.width; x++) { let selected = expand ? 0 : 255; for (let yy = Math.max(0, y - r); yy <= Math.min(value.height - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(value.width - 1, x + r); xx++) selected = expand ? Math.max(selected, value.alpha[yy * value.width + xx]!) : Math.min(selected, value.alpha[yy * value.width + xx]!); result.alpha[y * value.width + x] = selected; } return result; };
export const featherSelection = (value: PixelSelection, radius: number): PixelSelection => { const source = selectionToMask(value); const blurred = boxBlur(source, radius); return maskToSelection(blurred); };

/** Patch-based deterministic fill. It is intentionally conservative: the
 * selected area is filled from the nearest unselected ring, preserving alpha
 * and avoiding an opaque black fallback when no source pixels exist. */
export const contentAwareFill = (source: PixelBuffer, area: PixelSelection): PixelBuffer => { const result = clone(source); const r = Math.max(1, Math.min(64, Math.ceil(Math.max(source.width, source.height) / 64))); const samples: number[][] = []; for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) if (!area.alpha[y * source.width + x] && ((x > 0 && area.alpha[y * source.width + x - 1]) || (x + 1 < source.width && area.alpha[y * source.width + x + 1]) || (y > 0 && area.alpha[(y - 1) * source.width + x]) || (y + 1 < source.height && area.alpha[(y + 1) * source.width + x]))) samples.push(pixel(source, x, y)); const average = [0, 1, 2, 3].map((c) => samples.reduce((sum, item) => sum + item[c]!, 0) / Math.max(1, samples.length)); for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) if (area.alpha[y * source.width + x]) { const sourcePixel = samples[(x + y * r) % Math.max(1, samples.length)] ?? average; write(result, x, y, sourcePixel); } return result; };
export const removeBackground = (source: PixelBuffer, subject: PixelSelection): PixelBuffer => { const result = clone(source); for (let i = 0; i < subject.alpha.length; i++) result.data[i * 4 + 3] = Math.round(result.data[i * 4 + 3]! * subject.alpha[i]! / 255); return result; };
