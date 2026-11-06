import type {ManualLayerPoint} from './manual-layer-types';
import type {LayerBounds} from './types';

export type MaskPixels = {
	width: number;
	height: number;
	alpha: Uint8ClampedArray<ArrayBufferLike>;
};

export type RasterizeMaskOptions = {
	invert?: boolean;
	featherRadius?: number;
	expandPixels?: number;
};

const finite = (value: number): boolean => Number.isFinite(value);

const assertCanvas = (width: number, height: number): void => {
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width <= 0 ||
		height <= 0
	) {
		throw new Error('Mask canvas must have positive integer dimensions');
	}
};

export const validateMaskPolygon = (
	polygon: readonly ManualLayerPoint[],
	canvas: {width: number; height: number},
): void => {
	assertCanvas(canvas.width, canvas.height);
	if (polygon.length < 3) {
		throw new Error('Mask polygon needs at least 3 points');
	}

	for (const point of polygon) {
		if (
			!finite(point.x) ||
			!finite(point.y) ||
			point.x < 0 ||
			point.y < 0 ||
			point.x > canvas.width ||
			point.y > canvas.height
		) {
			throw new Error('Mask polygon contains a point outside the canvas');
		}
	}
};

export const getPolygonBounds = (
	polygon: readonly ManualLayerPoint[],
	canvas: {width: number; height: number},
): LayerBounds => {
	validateMaskPolygon(polygon, canvas);

	const minX = Math.max(
		0,
		Math.floor(Math.min(...polygon.map((point) => point.x))),
	);
	const minY = Math.max(
		0,
		Math.floor(Math.min(...polygon.map((point) => point.y))),
	);
	const maxX = Math.min(
		canvas.width,
		Math.ceil(Math.max(...polygon.map((point) => point.x))),
	);
	const maxY = Math.min(
		canvas.height,
		Math.ceil(Math.max(...polygon.map((point) => point.y))),
	);

	if (maxX <= minX || maxY <= minY) {
		throw new Error('Mask polygon has no drawable area');
	}

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY,
	};
};

export const pointInPolygon = (
	point: ManualLayerPoint,
	polygon: readonly ManualLayerPoint[],
): boolean => {
	let inside = false;
	for (
		let index = 0, previous = polygon.length - 1;
		index < polygon.length;
		previous = index++
	) {
		const currentPoint = polygon[index];
		const previousPoint = polygon[previous];
		const intersects =
			currentPoint.y > point.y !== previousPoint.y > point.y &&
			point.x <
				((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
					(previousPoint.y - currentPoint.y) +
					currentPoint.x;
		if (intersects) {
			inside = !inside;
		}
	}
	return inside;
};

const clampByte = (value: number): number => {
	return Math.max(0, Math.min(255, Math.round(value)));
};

const morphologyOffsets = (radius: number): Array<[number, number]> => {
	const offsets: Array<[number, number]> = [];
	for (let y = -radius; y <= radius; y++) {
		for (let x = -radius; x <= radius; x++) {
			if (x * x + y * y <= radius * radius) {
				offsets.push([x, y]);
			}
		}
	}
	return offsets;
};

const applyExpansion = (
	alpha: Uint8ClampedArray<ArrayBufferLike>,
	width: number,
	height: number,
	pixels: number,
): Uint8ClampedArray<ArrayBufferLike> => {
	const radius = Math.abs(Math.trunc(pixels));
	if (radius === 0) {
		return alpha;
	}

	const offsets = morphologyOffsets(radius);
	const result = new Uint8ClampedArray(alpha.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let value = pixels > 0 ? 0 : 255;
			for (const [offsetX, offsetY] of offsets) {
				const nextX = x + offsetX;
				const nextY = y + offsetY;
				if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
					if (pixels < 0) {
						value = 0;
					}
					continue;
				}

				const nextValue = alpha[nextY * width + nextX];
				value =
					pixels > 0 ? Math.max(value, nextValue) : Math.min(value, nextValue);
			}
			result[y * width + x] = value;
		}
	}
	return result;
};

const blurMask = (
	alpha: Uint8ClampedArray<ArrayBufferLike>,
	width: number,
	height: number,
	radius: number,
): Uint8ClampedArray<ArrayBufferLike> => {
	const next = new Uint8ClampedArray(alpha.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			let count = 0;
			for (let offsetY = -radius; offsetY <= radius; offsetY++) {
				for (let offsetX = -radius; offsetX <= radius; offsetX++) {
					const sampleX = x + offsetX;
					const sampleY = y + offsetY;
					if (
						sampleX < 0 ||
						sampleY < 0 ||
						sampleX >= width ||
						sampleY >= height
					) {
						continue;
					}
					sum += alpha[sampleY * width + sampleX];
					count++;
				}
			}
			next[y * width + x] = count === 0 ? 0 : clampByte(sum / count);
		}
	}
	return next;
};

export const rasterizePolygonMask = (
	polygon: readonly ManualLayerPoint[],
	canvas: {width: number; height: number},
	options: RasterizeMaskOptions = {},
): MaskPixels => {
	validateMaskPolygon(polygon, canvas);
	const width = canvas.width;
	const height = canvas.height;
	const alpha = new Uint8ClampedArray(width * height);
	const bounds = getPolygonBounds(polygon, canvas);
	const sampleOffsets = [-0.25, 0.25];

	for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
		for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
			let covered = 0;
			for (const offsetY of sampleOffsets) {
				for (const offsetX of sampleOffsets) {
					covered += pointInPolygon(
						{x: x + 0.5 + offsetX, y: y + 0.5 + offsetY},
						polygon,
					)
						? 1
						: 0;
				}
			}
			alpha[y * width + x] = clampByte((covered / 4) * 255);
		}
	}

	let nextAlpha: Uint8ClampedArray<ArrayBufferLike> = alpha;
	if (options.expandPixels) {
		nextAlpha = applyExpansion(nextAlpha, width, height, options.expandPixels);
	}
	if (options.featherRadius && options.featherRadius > 0) {
		nextAlpha = blurMask(
			nextAlpha,
			width,
			height,
			Math.max(1, Math.trunc(options.featherRadius)),
		);
	}
	if (options.invert) {
		const inverted = new Uint8ClampedArray(nextAlpha.length);
		for (let index = 0; index < nextAlpha.length; index++) {
			inverted[index] = 255 - nextAlpha[index];
		}
		nextAlpha = inverted;
	}

	return {width, height, alpha: nextAlpha};
};

export const maskToRgba = (
	mask: MaskPixels,
): Uint8ClampedArray<ArrayBufferLike> => {
	const rgba = new Uint8ClampedArray(mask.width * mask.height * 4);
	for (let index = 0; index < mask.alpha.length; index++) {
		const alpha = mask.alpha[index];
		const offset = index * 4;
		rgba[offset] = alpha;
		rgba[offset + 1] = alpha;
		rgba[offset + 2] = alpha;
		rgba[offset + 3] = 255;
	}
	return rgba;
};
