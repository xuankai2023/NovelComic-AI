import type {AssetRecord} from '../document';
import type {MaskSurface} from './mask-pixel-core';
const hash = (alpha: Uint8ClampedArray) => {
	let value = 2166136261;
	for (const byte of alpha) {
		value ^= byte;
		value = Math.imul(value, 16777619);
	}
	return (value >>> 0).toString(16).padStart(8, '0');
};
export const maskSurfaceToDataUrl = (surface: MaskSurface): string => {
	const canvas = document.createElement('canvas');
	canvas.width = surface.width;
	canvas.height = surface.height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Canvas2D is required for mask encoding');
	const image = context.createImageData(surface.width, surface.height);
	for (let index = 0; index < surface.alpha.length; index++) {
		const offset = index * 4;
		image.data[offset] = 255;
		image.data[offset + 1] = 255;
		image.data[offset + 2] = 255;
		image.data[offset + 3] = surface.alpha[index];
	}
	context.putImageData(image, 0, 0);
	return canvas.toDataURL('image/png');
};
export const createMaskAsset = (
	surface: MaskSurface,
	id = `mask-${crypto.randomUUID()}`,
): AssetRecord => {
	const contentHash = hash(surface.alpha);
	return {
		id,
		kind: 'mask',
		originalName: `${id}.png`,
		mimeType: 'image/png',
		width: surface.width,
		height: surface.height,
		byteSize: surface.alpha.byteLength,
		objectKey: maskSurfaceToDataUrl(surface),
		contentHash,
	};
};
const loadImage = (url: string): Promise<HTMLImageElement> =>
	new Promise((resolve, reject) => {
		const image = new Image();
		image.crossOrigin = 'anonymous';
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error('Unable to load pixel asset'));
		image.src = url;
	});
export const loadMaskSurface = async (
	asset: Pick<AssetRecord, 'objectKey' | 'width' | 'height'>,
): Promise<MaskSurface> => {
	const image = await loadImage(asset.objectKey);
	const width = asset.width ?? image.naturalWidth;
	const height = asset.height ?? image.naturalHeight;
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Canvas2D is required for mask decoding');
	context.drawImage(image, 0, 0, width, height);
	const pixels = context.getImageData(0, 0, width, height).data;
	const alpha = new Uint8ClampedArray(width * height);
	for (let index = 0; index < alpha.length; index++)
		alpha[index] = pixels[index * 4 + 3];
	return {width, height, alpha};
};
export const applyMaskToRasterAsset = async ({
	source,
	mask,
	invert = false,
	id = `raster-${crypto.randomUUID()}`,
}: {
	source: AssetRecord;
	mask: MaskSurface;
	invert?: boolean;
	id?: string;
}): Promise<AssetRecord> => {
	const image = await loadImage(source.objectKey);
	const width = source.width ?? image.naturalWidth;
	const height = source.height ?? image.naturalHeight;
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Canvas2D is required for applying a mask');
	context.drawImage(image, 0, 0, width, height);
	const pixels = context.getImageData(0, 0, width, height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const sourceIndex = (y * width + x) * 4;
			const maskX = Math.min(
				mask.width - 1,
				Math.floor((x * mask.width) / width),
			);
			const maskY = Math.min(
				mask.height - 1,
				Math.floor((y * mask.height) / height),
			);
			const value = mask.alpha[maskY * mask.width + maskX] / 255;
			pixels.data[sourceIndex + 3] = Math.round(
				pixels.data[sourceIndex + 3] * (invert ? 1 - value : value),
			);
		}
	context.putImageData(pixels, 0, 0);
	const objectKey = canvas.toDataURL('image/png');
	return {
		id,
		kind: 'raster',
		originalName: `${id}.png`,
		mimeType: 'image/png',
		width,
		height,
		byteSize: pixels.data.byteLength,
		objectKey,
		contentHash: `${source.contentHash}-${hash(mask.alpha)}-${invert ? 'i' : 'n'}`,
	};
};
