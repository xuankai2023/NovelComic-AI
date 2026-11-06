import type {ManualLayerPoint} from './manual-layer-types';
import {
	getPolygonBounds,
	maskToRgba,
	rasterizePolygonMask,
	type RasterizeMaskOptions,
} from './rasterize-mask';
import type {LayerBounds} from './types';

export type RgbaPixels = {
	width: number;
	height: number;
	data: Uint8ClampedArray;
};

export type CutoutPixels = {
	bounds: LayerBounds;
	mask: RgbaPixels;
	cutout: RgbaPixels;
};

const assertPixels = (pixels: RgbaPixels): void => {
	if (
		!Number.isInteger(pixels.width) ||
		!Number.isInteger(pixels.height) ||
		pixels.width <= 0 ||
		pixels.height <= 0 ||
		pixels.data.length !== pixels.width * pixels.height * 4
	) {
		throw new Error('Source pixels have invalid dimensions');
	}
};

export const createCutoutPixels = ({
	source,
	polygon,
	options,
}: {
	source: RgbaPixels;
	polygon: readonly ManualLayerPoint[];
	options?: RasterizeMaskOptions;
}): CutoutPixels => {
	assertPixels(source);
	const bounds = options?.invert
		? {x: 0, y: 0, width: source.width, height: source.height}
		: getPolygonBounds(polygon, source);
	const mask = rasterizePolygonMask(polygon, source, options);
	const cutoutData = new Uint8ClampedArray(bounds.width * bounds.height * 4);

	for (let y = 0; y < bounds.height; y++) {
		for (let x = 0; x < bounds.width; x++) {
			const sourceX = bounds.x + x;
			const sourceY = bounds.y + y;
			const sourceOffset = (sourceY * source.width + sourceX) * 4;
			const cutoutOffset = (y * bounds.width + x) * 4;
			const maskOffset = sourceY * source.width + sourceX;
			const maskAlpha = mask.alpha[maskOffset];
			const sourceAlpha = source.data[sourceOffset + 3];
			const alpha = Math.round((sourceAlpha * maskAlpha) / 255);

			cutoutData[cutoutOffset] = source.data[sourceOffset];
			cutoutData[cutoutOffset + 1] = source.data[sourceOffset + 1];
			cutoutData[cutoutOffset + 2] = source.data[sourceOffset + 2];
			cutoutData[cutoutOffset + 3] = alpha;
		}
	}

	return {
		bounds,
		mask: {
			width: source.width,
			height: source.height,
			data: maskToRgba(mask),
		},
		cutout: {
			width: bounds.width,
			height: bounds.height,
			data: cutoutData,
		},
	};
};

const loadImage = (sourceUrl: string): Promise<HTMLImageElement> => {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.crossOrigin = 'anonymous';
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error('Could not load source image'));
		image.src = sourceUrl;
	});
};

export const encodePixelsAsPng = async (pixels: RgbaPixels): Promise<Blob> => {
	assertPixels(pixels);
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(pixels.width, pixels.height);
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('Could not create 2D canvas context');
		}
		const imageData = context.createImageData(pixels.width, pixels.height);
		imageData.data.set(pixels.data);
		context.putImageData(imageData, 0, 0);
		return canvas.convertToBlob({type: 'image/png'});
	}

	if (typeof document === 'undefined') {
		throw new Error('PNG encoding requires a browser canvas');
	}

	const canvas = document.createElement('canvas');
	canvas.width = pixels.width;
	canvas.height = pixels.height;
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('Could not create 2D canvas context');
	}
	const imageData = context.createImageData(pixels.width, pixels.height);
	imageData.data.set(pixels.data);
	context.putImageData(imageData, 0, 0);

	return new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (!blob) {
				reject(new Error('Could not encode PNG'));
				return;
			}
			resolve(blob);
		}, 'image/png');
	});
};

export const createManualLayerPngs = async ({
	sourceUrl,
	polygon,
	options,
}: {
	sourceUrl: string;
	polygon: readonly ManualLayerPoint[];
	options?: RasterizeMaskOptions;
}): Promise<CutoutPixels & {maskBlob: Blob; cutoutBlob: Blob}> => {
	const image = await loadImage(sourceUrl);
	const canvas = document.createElement('canvas');
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const context = canvas.getContext('2d', {willReadFrequently: true});
	if (!context) {
		throw new Error('Could not create source canvas context');
	}
	context.drawImage(image, 0, 0);
	const source = context.getImageData(0, 0, canvas.width, canvas.height);
	const pixels = createCutoutPixels({
		source: {
			width: source.width,
			height: source.height,
			data: source.data,
		},
		polygon,
		options,
	});

	return {
		...pixels,
		maskBlob: await encodePixelsAsPng(pixels.mask),
		cutoutBlob: await encodePixelsAsPng(pixels.cutout),
	};
};
