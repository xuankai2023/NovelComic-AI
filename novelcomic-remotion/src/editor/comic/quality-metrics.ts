export type RgbaFrame = {
	width: number;
	height: number;
	data: Uint8ClampedArray;
};

export type LayerQualityMetrics = {
	recompositionScore: number;
	alphaHoleRatio: number;
};

const assertFrame = (frame: RgbaFrame, label: string): void => {
	if (
		!Number.isInteger(frame.width) ||
		!Number.isInteger(frame.height) ||
		frame.width <= 0 ||
		frame.height <= 0 ||
		frame.data.length !== frame.width * frame.height * 4
	) {
		throw new Error(`${label} has invalid RGBA dimensions`);
	}
};

const assertCompatible = (source: RgbaFrame, result: RgbaFrame): void => {
	assertFrame(source, 'Source frame');
	assertFrame(result, 'Recomposed frame');
	if (source.width !== result.width || source.height !== result.height) {
		throw new Error(
			'Source and recomposed frames must have matching dimensions',
		);
	}
};

/**
 * Returns a normalized per-channel difference score in the range [0, 1].
 * Transparent source pixels are ignored because their RGB channels are not
 * visually meaningful after compositing.
 */
export const calculateRecompositionScore = (
	source: RgbaFrame,
	recomposed: RgbaFrame,
): number => {
	assertCompatible(source, recomposed);
	let total = 0;
	let count = 0;

	for (let offset = 0; offset < source.data.length; offset += 4) {
		const sourceAlpha = source.data[offset + 3] ?? 0;
		const resultAlpha = recomposed.data[offset + 3] ?? 0;
		if (sourceAlpha === 0 && resultAlpha === 0) {
			continue;
		}

		total += Math.abs(
			(source.data[offset] ?? 0) - (recomposed.data[offset] ?? 0),
		);
		total += Math.abs(
			(source.data[offset + 1] ?? 0) - (recomposed.data[offset + 1] ?? 0),
		);
		total += Math.abs(
			(source.data[offset + 2] ?? 0) - (recomposed.data[offset + 2] ?? 0),
		);
		total += Math.abs(sourceAlpha - resultAlpha);
		count += 4;
	}

	if (count === 0) {
		return 0;
	}

	return total / (count * 255);
};

/**
 * Measures source pixels that became transparent in the recomposed result.
 * A source alpha of 16 keeps anti-aliased edges from being classified as
 * holes while still catching fully transparent gaps.
 */
export const calculateAlphaHoleRatio = (
	source: RgbaFrame,
	recomposed: RgbaFrame,
): number => {
	assertCompatible(source, recomposed);
	let sourceOpaquePixels = 0;
	let holes = 0;

	for (let offset = 0; offset < source.data.length; offset += 4) {
		const sourceAlpha = source.data[offset + 3] ?? 0;
		const resultAlpha = recomposed.data[offset + 3] ?? 0;
		if (sourceAlpha < 16) {
			continue;
		}

		sourceOpaquePixels++;
		if (resultAlpha < 16) {
			holes++;
		}
	}

	return sourceOpaquePixels === 0 ? 0 : holes / sourceOpaquePixels;
};

export const inspectLayerQuality = (
	source: RgbaFrame,
	recomposed: RgbaFrame,
): LayerQualityMetrics => {
	return {
		recompositionScore: calculateRecompositionScore(source, recomposed),
		alphaHoleRatio: calculateAlphaHoleRatio(source, recomposed),
	};
};
