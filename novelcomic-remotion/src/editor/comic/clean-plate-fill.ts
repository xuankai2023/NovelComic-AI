import type {ManualLayerPoint} from './manual-layer-types';
import type {MaskPixels} from './rasterize-mask';

export type CleanPlatePixels = {
	width: number;
	height: number;
	data: Uint8ClampedArray;
};

export type CleanPlateColor = {
	r: number;
	g: number;
	b: number;
	a?: number;
};

export type CloneFillOptions = {
	source: ManualLayerPoint;
	target?: ManualLayerPoint;
};

export type CleanPlateLocalFillMode =
	| 'solid-fill'
	| 'clone-fill'
	| 'opencv-inpaint';

export type CleanPlateLocalFillInput = {
	source: CleanPlatePixels;
	mask: MaskPixels;
	mode: CleanPlateLocalFillMode;
	fillColor?: CleanPlateColor | string;
	clone?: CloneFillOptions;
	maxInpaintPixels?: number;
};

export type CleanPlateLocalFillResult = {
	pixels: CleanPlatePixels;
	mode: CleanPlateLocalFillMode;
	applied: boolean;
	fellBack: boolean;
	warnings: string[];
};

const assertPixels = (pixels: CleanPlatePixels, label: string): void => {
	if (
		!Number.isInteger(pixels.width) ||
		!Number.isInteger(pixels.height) ||
		pixels.width <= 0 ||
		pixels.height <= 0 ||
		pixels.data.length !== pixels.width * pixels.height * 4
	) {
		throw new Error(`${label} has invalid dimensions`);
	}
};

const assertMask = (mask: MaskPixels): void => {
	if (
		!Number.isInteger(mask.width) ||
		!Number.isInteger(mask.height) ||
		mask.width <= 0 ||
		mask.height <= 0 ||
		mask.alpha.length !== mask.width * mask.height
	) {
		throw new Error('Clean plate mask has invalid dimensions');
	}
};

const assertCompatible = (
	source: CleanPlatePixels,
	mask: MaskPixels,
): void => {
	assertPixels(source, 'Clean plate source');
	assertMask(mask);
	if (source.width !== mask.width || source.height !== mask.height) {
		throw new Error('Clean plate source and mask dimensions must match');
	}
};

const clampByte = (value: number): number => {
	return Math.max(0, Math.min(255, Math.round(value)));
};

const clampCoordinate = (value: number, limit: number): number => {
	return Math.max(0, Math.min(limit - 1, Math.round(value)));
};

const clonePixels = (pixels: CleanPlatePixels): CleanPlatePixels => {
	return {
		width: pixels.width,
		height: pixels.height,
		data: new Uint8ClampedArray(pixels.data),
	};
};

const assertColorChannel = (value: number, label: string): number => {
	if (!Number.isFinite(value) || value < 0 || value > 255) {
		throw new Error(`${label} must be between 0 and 255`);
	}
	return Math.round(value);
};

export const parseCleanPlateColor = (
	value: CleanPlateColor | string,
): Required<CleanPlateColor> => {
	if (typeof value !== 'string') {
		return {
			r: assertColorChannel(value.r, 'Fill color red'),
			g: assertColorChannel(value.g, 'Fill color green'),
			b: assertColorChannel(value.b, 'Fill color blue'),
			a: assertColorChannel(value.a ?? 255, 'Fill color alpha'),
		};
	}

	const color = value.trim();
	const shortHex = /^#([0-9a-f]{3,4})$/i.exec(color);
	if (shortHex) {
		const expanded = [...shortHex[1]!]
			.map((channel) => `${channel}${channel}`)
			.join('');
		return parseCleanPlateColor(`#${expanded}`);
	}

	const hex = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color);
	if (hex) {
		const valueWithoutHash = hex[1]!;
		return {
			r: Number.parseInt(valueWithoutHash.slice(0, 2), 16),
			g: Number.parseInt(valueWithoutHash.slice(2, 4), 16),
			b: Number.parseInt(valueWithoutHash.slice(4, 6), 16),
			a:
				valueWithoutHash.length === 8
					? Number.parseInt(valueWithoutHash.slice(6, 8), 16)
					: 255,
		};
	}

	const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(
		color,
	);
	if (rgb) {
		const alpha = rgb[4] === undefined ? 255 : Number(rgb[4]) * 255;
		return {
			r: assertColorChannel(Number(rgb[1]), 'Fill color red'),
			g: assertColorChannel(Number(rgb[2]), 'Fill color green'),
			b: assertColorChannel(Number(rgb[3]), 'Fill color blue'),
			a: assertColorChannel(alpha, 'Fill color alpha'),
		};
	}

	throw new Error('Fill color must be a hex or rgb/rgba color');
};

const maskCoverage = (mask: MaskPixels, index: number): number => {
	return mask.alpha[index]! / 255;
};

const replaceMaskedPixels = (
	source: CleanPlatePixels,
	mask: MaskPixels,
	replacement: (x: number, y: number, index: number) => CleanPlateColor,
): CleanPlatePixels => {
	const result = clonePixels(source);
	for (let y = 0; y < source.height; y++) {
		for (let x = 0; x < source.width; x++) {
			const index = y * source.width + x;
			const coverage = maskCoverage(mask, index);
			if (coverage <= 0) {
				continue;
			}

			const color = replacement(x, y, index);
			const colorAlpha = (color.a ?? 255) / 255;
			const amount = coverage * colorAlpha;
			const offset = index * 4;
			result.data[offset] = clampByte(
				source.data[offset]! * (1 - amount) + color.r * amount,
			);
			result.data[offset + 1] = clampByte(
				source.data[offset + 1]! * (1 - amount) + color.g * amount,
			);
			result.data[offset + 2] = clampByte(
				source.data[offset + 2]! * (1 - amount) + color.b * amount,
			);
		}
	}
	return result;
};

const maskBounds = (mask: MaskPixels): {
	x: number;
	y: number;
	width: number;
	height: number;
} | null => {
	let minX = mask.width;
	let minY = mask.height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < mask.height; y++) {
		for (let x = 0; x < mask.width; x++) {
			if (mask.alpha[y * mask.width + x]! === 0) {
				continue;
			}
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}

	if (maxX < minX || maxY < minY) {
		return null;
	}

	return {
		x: minX,
		y: minY,
		width: maxX - minX + 1,
		height: maxY - minY + 1,
	};
};

export const applySolidFill = ({
	source,
	mask,
	color,
}: {
	source: CleanPlatePixels;
	mask: MaskPixels;
	color: CleanPlateColor | string;
}): CleanPlatePixels => {
	assertCompatible(source, mask);
	const parsed = parseCleanPlateColor(color);
	return replaceMaskedPixels(source, mask, () => parsed);
};

const validatePoint = (
	point: ManualLayerPoint,
	width: number,
	height: number,
	label: string,
): void => {
	if (
		!Number.isFinite(point.x) ||
		!Number.isFinite(point.y) ||
		point.x < 0 ||
		point.y < 0 ||
		point.x >= width ||
		point.y >= height
	) {
		throw new Error(`${label} must be inside the source canvas`);
	}
};

export const applyCloneFill = ({
	source,
	mask,
	clone,
}: {
	source: CleanPlatePixels;
	mask: MaskPixels;
	clone: CloneFillOptions;
}): CleanPlatePixels => {
	assertCompatible(source, mask);
	validatePoint(clone.source, source.width, source.height, 'Clone source');
	const target = clone.target ?? maskBounds(mask);
	if (!target) {
		return clonePixels(source);
	}
	validatePoint(target, source.width, source.height, 'Clone target');

	const original = clonePixels(source);
	return replaceMaskedPixels(source, mask, (x, y) => {
		const sampleX = clampCoordinate(
			clone.source.x + x - target.x,
			source.width,
		);
		const sampleY = clampCoordinate(
			clone.source.y + y - target.y,
			source.height,
		);
		const sampleOffset = (sampleY * source.width + sampleX) * 4;
		return {
			r: original.data[sampleOffset]!,
			g: original.data[sampleOffset + 1]!,
			b: original.data[sampleOffset + 2]!,
			a: original.data[sampleOffset + 3]!,
		};
	});
};

const averageNeighbors = (
	pixels: CleanPlatePixels,
	known: Uint8Array,
	x: number,
	y: number,
): CleanPlateColor | null => {
	let red = 0;
	let green = 0;
	let blue = 0;
	let alpha = 0;
	let count = 0;
	for (const [offsetX, offsetY] of [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	] as const) {
		const sampleX = x + offsetX;
		const sampleY = y + offsetY;
		if (
			sampleX < 0 ||
			sampleY < 0 ||
			sampleX >= pixels.width ||
			sampleY >= pixels.height
		) {
			continue;
		}
		const sampleIndex = sampleY * pixels.width + sampleX;
		if (known[sampleIndex] !== 1) {
			continue;
		}
		const sampleOffset = sampleIndex * 4;
		red += pixels.data[sampleOffset]!;
		green += pixels.data[sampleOffset + 1]!;
		blue += pixels.data[sampleOffset + 2]!;
		alpha += pixels.data[sampleOffset + 3]!;
		count++;
	}

	return count === 0
		? null
		: {r: red / count, g: green / count, b: blue / count, a: alpha / count};
};

/**
 * A deterministic local fallback for small holes. It deliberately only
 * changes masked pixels and can therefore run in a browser worker without
 * depending on OpenCV.
 */
export const applyLocalInpaint = ({
	source,
	mask,
	maxPixels = 25_000,
}: {
	source: CleanPlatePixels;
	mask: MaskPixels;
	maxPixels?: number;
}): {pixels: CleanPlatePixels; applied: boolean; warning?: string} => {
	assertCompatible(source, mask);
	if (!Number.isInteger(maxPixels) || maxPixels < 1) {
		throw new Error('maxPixels must be a positive integer');
	}

	const maskedPixels = mask.alpha.reduce(
		(count, alpha) => count + (alpha > 0 ? 1 : 0),
		0,
	);
	if (maskedPixels === 0) {
		return {pixels: clonePixels(source), applied: false};
	}
	if (maskedPixels > maxPixels) {
		return {
			pixels: clonePixels(source),
			applied: false,
			warning: `Inpaint region exceeds ${maxPixels} pixels`,
		};
	}

	const result = clonePixels(source);
	const known = new Uint8Array(source.width * source.height);
	for (let index = 0; index < known.length; index++) {
		if (mask.alpha[index] === 0) {
			known[index] = 1;
		}
	}

	let remaining = maskedPixels;
	while (remaining > 0) {
		const updates: Array<{
			index: number;
			color: CleanPlateColor;
		}> = [];
		for (let y = 0; y < source.height; y++) {
			for (let x = 0; x < source.width; x++) {
				const index = y * source.width + x;
				if (known[index] === 1 || mask.alpha[index] === 0) {
					continue;
				}
				const color = averageNeighbors(result, known, x, y);
				if (color) {
					updates.push({index, color});
				}
			}
		}

		if (updates.length === 0) {
			return {
				pixels: clonePixels(source),
				applied: false,
				warning: 'Inpaint region has no reachable source pixels',
			};
		}

		for (const update of updates) {
			const offset = update.index * 4;
			const coverage = mask.alpha[update.index]! / 255;
			result.data[offset] = clampByte(
				source.data[offset]! * (1 - coverage) +
					update.color.r * coverage,
			);
			result.data[offset + 1] = clampByte(
				source.data[offset + 1]! * (1 - coverage) +
					update.color.g * coverage,
			);
			result.data[offset + 2] = clampByte(
				source.data[offset + 2]! * (1 - coverage) +
					update.color.b * coverage,
			);
			result.data[offset + 3] = clampByte(
				source.data[offset + 3]! * (1 - coverage) +
					(update.color.a ?? source.data[offset + 3]!) * coverage,
			);
			known[update.index] = 1;
		}
		remaining -= updates.length;
	}

	return {pixels: result, applied: true};
};

export const fillCleanPlatePixels = (
	input: CleanPlateLocalFillInput,
): CleanPlateLocalFillResult => {
	assertCompatible(input.source, input.mask);

	try {
		if (input.mode === 'solid-fill') {
			if (!input.fillColor) {
				throw new Error('Solid fill requires a fill color');
			}
			return {
				pixels: applySolidFill({
					source: input.source,
					mask: input.mask,
					color: input.fillColor,
				}),
				mode: input.mode,
				applied: true,
				fellBack: false,
				warnings: [],
			};
		}

		if (input.mode === 'clone-fill') {
			if (!input.clone) {
				throw new Error('Clone fill requires a clone source point');
			}
			return {
				pixels: applyCloneFill({
					source: input.source,
					mask: input.mask,
					clone: input.clone,
				}),
				mode: input.mode,
				applied: true,
				fellBack: false,
				warnings: [],
			};
		}

		const local = applyLocalInpaint({
			source: input.source,
			mask: input.mask,
			maxPixels: input.maxInpaintPixels,
		});
		return {
			pixels: local.pixels,
			mode: input.mode,
			applied: local.applied,
			fellBack: !local.applied,
			warnings: local.warning ? [local.warning] : [],
		};
	} catch (error) {
		return {
			pixels: clonePixels(input.source),
			mode: input.mode,
			applied: false,
			fellBack: true,
			warnings: [error instanceof Error ? error.message : 'Clean plate fill failed'],
		};
	}
};
