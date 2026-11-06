import {
	fillCleanPlatePixels,
	type CleanPlateLocalFillMode,
	type CleanPlatePixels,
} from './clean-plate-fill';
import {encodePixelsAsPng, type RgbaPixels} from './create-cutout-asset';
import type {ManualLayerPoint} from './manual-layer-types';
import type {MaskPixels} from './rasterize-mask';

const loadImage = (sourceUrl: string): Promise<HTMLImageElement> => {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.crossOrigin = 'anonymous';
		image.onload = () => resolve(image);
		image.onerror = () =>
			reject(new Error(`Could not load image: ${sourceUrl}`));
		image.src = sourceUrl;
	});
};

const readImagePixels = async (
	sourceUrl: string,
): Promise<CleanPlatePixels> => {
	const image = await loadImage(sourceUrl);
	const canvas = document.createElement('canvas');
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const context = canvas.getContext('2d', {willReadFrequently: true});
	if (!context) {
		throw new Error('Could not create clean plate canvas context');
	}

	context.drawImage(image, 0, 0);
	const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	return {
		width: imageData.width,
		height: imageData.height,
		data: imageData.data,
	};
};

export type CreateCleanPlatePngInput = {
	sourceUrl: string;
	maskUrl: string;
	mode?: CleanPlateLocalFillMode;
	cloneSource?: ManualLayerPoint;
	maxInpaintPixels?: number;
};

export type CreateCleanPlatePngResult = {
	blob: Blob;
	method: CleanPlateLocalFillMode;
	repairedPixelCount: number;
	warnings: string[];
};

export const createCleanPlatePng = async ({
	sourceUrl,
	maskUrl,
	mode = 'opencv-inpaint',
	cloneSource,
	maxInpaintPixels = 250_000,
}: CreateCleanPlatePngInput): Promise<CreateCleanPlatePngResult> => {
	const source = await readImagePixels(sourceUrl);
	const maskRgba = await readImagePixels(maskUrl);
	if (source.width !== maskRgba.width || source.height !== maskRgba.height) {
		throw new Error('Clean plate source and mask dimensions must match');
	}

	const mask: MaskPixels = {
		width: maskRgba.width,
		height: maskRgba.height,
		alpha: new Uint8ClampedArray(maskRgba.data.length / 4),
	};
	for (let index = 0; index < mask.alpha.length; index++) {
		mask.alpha[index] = maskRgba.data[index * 4 + 3]!;
	}

	const filled = fillCleanPlatePixels({
		source,
		mask,
		mode,
		clone: cloneSource ? {source: cloneSource} : undefined,
		maxInpaintPixels,
	});
	if (!filled.applied) {
		throw new Error(
			filled.warnings.join('; ') || 'Clean Plate fill did not change the image',
		);
	}

	const repairedPixelCount = mask.alpha.reduce(
		(count, alpha) => count + (alpha > 0 ? 1 : 0),
		0,
	);
	return {
		blob: await encodePixelsAsPng(filled.pixels as RgbaPixels),
		method: filled.mode,
		repairedPixelCount,
		warnings: filled.warnings,
	};
};
