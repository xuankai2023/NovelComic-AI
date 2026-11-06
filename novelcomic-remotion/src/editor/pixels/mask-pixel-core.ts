export type MaskRect = {x: number; y: number; width: number; height: number};
export type MaskPoint = {x: number; y: number; pressure?: number};
export type MaskSurface = {
	width: number;
	height: number;
	alpha: Uint8ClampedArray<ArrayBufferLike>;
};
export type MaskBrush = {size: number; hardness: number; opacity: number};
export type MaskTileDiff = {
	tileSize: number;
	tiles: Array<{
		x: number;
		y: number;
		width: number;
		height: number;
		before: Uint8Array;
		after: Uint8Array;
	}>;
	byteLength: number;
};

export const createMaskSurface = (
	width: number,
	height: number,
	value = 255,
): MaskSurface => ({
	width,
	height,
	alpha: new Uint8ClampedArray(width * height).fill(value),
});
export const cloneMaskSurface = (surface: MaskSurface): MaskSurface => ({
	width: surface.width,
	height: surface.height,
	alpha: new Uint8ClampedArray(surface.alpha),
});
const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));
const circle = (
	surface: MaskSurface,
	point: MaskPoint,
	brush: MaskBrush,
	mode: 'paint' | 'erase',
) => {
	const radius = Math.max(0.5, brush.size / 2);
	const hardness = clamp(brush.hardness, 0, 1);
	const opacity = clamp(brush.opacity * (point.pressure ?? 1), 0, 1);
	const left = Math.max(0, Math.floor(point.x - radius));
	const right = Math.min(surface.width - 1, Math.ceil(point.x + radius));
	const top = Math.max(0, Math.floor(point.y - radius));
	const bottom = Math.min(surface.height - 1, Math.ceil(point.y + radius));
	for (let y = top; y <= bottom; y++)
		for (let x = left; x <= right; x++) {
			const distance =
				Math.hypot(x + 0.5 - point.x, y + 0.5 - point.y) / radius;
			if (distance > 1) continue;
			const coverage =
				distance <= hardness
					? 1
					: 1 - (distance - hardness) / Math.max(0.0001, 1 - hardness);
			const index = y * surface.width + x;
			const target = mode === 'paint' ? 255 : 0;
			surface.alpha[index] = Math.round(
				surface.alpha[index] +
					(target - surface.alpha[index]) * coverage * opacity,
			);
		}
};
const blurRegion = (
	surface: MaskSurface,
	points: MaskPoint[],
	brush: MaskBrush,
) => {
	const source = new Uint8ClampedArray(surface.alpha);
	const radius = Math.max(1, Math.round(brush.size / 8));
	for (const point of points) {
		const left = Math.max(0, Math.floor(point.x - brush.size / 2));
		const right = Math.min(
			surface.width - 1,
			Math.ceil(point.x + brush.size / 2),
		);
		const top = Math.max(0, Math.floor(point.y - brush.size / 2));
		const bottom = Math.min(
			surface.height - 1,
			Math.ceil(point.y + brush.size / 2),
		);
		for (let y = top; y <= bottom; y++)
			for (let x = left; x <= right; x++) {
				let sum = 0;
				let count = 0;
				for (
					let py = Math.max(0, y - radius);
					py <= Math.min(surface.height - 1, y + radius);
					py++
				)
					for (
						let px = Math.max(0, x - radius);
						px <= Math.min(surface.width - 1, x + radius);
						px++
					) {
						sum += source[py * surface.width + px];
						count++;
					}
				const index = y * surface.width + x;
				surface.alpha[index] = Math.round(
					source[index] + (sum / count - source[index]) * brush.opacity,
				);
			}
	}
};
export const applyMaskStroke = (
	surface: MaskSurface,
	points: MaskPoint[],
	brush: MaskBrush,
	mode: 'paint' | 'erase' | 'blur',
): MaskSurface => {
	const next = cloneMaskSurface(surface);
	if (mode === 'blur') blurRegion(next, points, brush);
	else for (const point of points) circle(next, point, brush, mode);
	return next;
};
const boxBlur = (
	alpha: Uint8ClampedArray<ArrayBufferLike>,
	width: number,
	height: number,
	radius: number,
): Uint8ClampedArray<ArrayBufferLike> => {
	if (radius <= 0) return alpha;
	const out = new Uint8ClampedArray(alpha.length);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			let sum = 0;
			let count = 0;
			for (
				let py = Math.max(0, y - radius);
				py <= Math.min(height - 1, y + radius);
				py++
			)
				for (
					let px = Math.max(0, x - radius);
					px <= Math.min(width - 1, x + radius);
					px++
				) {
					sum += alpha[py * width + px];
					count++;
				}
			out[y * width + x] = Math.round(sum / count);
		}
	return out;
};
export const refineMaskSurface = (
	surface: MaskSurface,
	settings: {
		smooth: number;
		feather: number;
		contrast: number;
		shiftEdge: number;
	},
): MaskSurface => {
	let alpha: Uint8ClampedArray<ArrayBufferLike> = new Uint8ClampedArray(
		surface.alpha,
	);
	const blur = Math.min(
		24,
		Math.max(0, Math.round(settings.smooth / 20 + settings.feather)),
	);
	alpha = boxBlur(alpha, surface.width, surface.height, blur);
	const contrast = 1 + settings.contrast / 100;
	const shift = settings.shiftEdge * 1.275;
	for (let index = 0; index < alpha.length; index++)
		alpha[index] = clamp(
			Math.round((alpha[index] - 127.5) * contrast + 127.5 + shift),
			0,
			255,
		);
	return {width: surface.width, height: surface.height, alpha};
};
export const invertMaskSurface = (surface: MaskSurface): MaskSurface => ({
	width: surface.width,
	height: surface.height,
	alpha: Uint8ClampedArray.from(surface.alpha, (value) => 255 - value),
});
const same = (
	a: Uint8ClampedArray,
	b: Uint8ClampedArray,
	width: number,
	rect: MaskRect,
) => {
	for (let y = 0; y < rect.height; y++)
		for (let x = 0; x < rect.width; x++) {
			const index = (rect.y + y) * width + rect.x + x;
			if (a[index] !== b[index]) return false;
		}
	return true;
};
const region = (source: Uint8ClampedArray, width: number, rect: MaskRect) => {
	const out = new Uint8Array(rect.width * rect.height);
	for (let y = 0; y < rect.height; y++)
		out.set(
			source.subarray(
				(rect.y + y) * width + rect.x,
				(rect.y + y) * width + rect.x + rect.width,
			),
			y * rect.width,
		);
	return out;
};
export const createMaskTileDiff = (
	before: MaskSurface,
	after: MaskSurface,
	tileSize = 64,
): MaskTileDiff => {
	if (before.width !== after.width || before.height !== after.height)
		throw new Error('Mask dimensions must match');
	const tiles: MaskTileDiff['tiles'] = [];
	for (let y = 0; y < before.height; y += tileSize)
		for (let x = 0; x < before.width; x += tileSize) {
			const rect = {
				x,
				y,
				width: Math.min(tileSize, before.width - x),
				height: Math.min(tileSize, before.height - y),
			};
			if (!same(before.alpha, after.alpha, before.width, rect))
				tiles.push({
					...rect,
					before: region(before.alpha, before.width, rect),
					after: region(after.alpha, after.width, rect),
				});
		}
	return {
		tileSize,
		tiles,
		byteLength: tiles.reduce(
			(sum, tile) => sum + tile.before.byteLength + tile.after.byteLength,
			0,
		),
	};
};
