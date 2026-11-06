import type {AssetRecord} from '../../document/types';
import {createPixelBuffer, type PixelBuffer} from '../../pixels/pixel-tools';

type Entry = {buffer: PixelBuffer; canvas: HTMLCanvasElement | null};

const sources = new Map<string, Entry>();
const overrides = new Map<string, Entry>();
let revision = 0;
const listeners = new Set<() => void>();

const emit = () => {
	revision += 1;
	for (const listener of listeners) listener();
};

const hashPixels = (data: Uint8ClampedArray) => {
	let value = 2166136261;
	for (let index = 0; index < data.length; index += 1) {
		value ^= data[index]!;
		value = Math.imul(value, 16777619);
	}
	return (value >>> 0).toString(16).padStart(8, '0');
};

const canvasFrom = (buffer: PixelBuffer): HTMLCanvasElement | null => {
	if (typeof document === 'undefined') return null;
	const canvas = document.createElement('canvas');
	canvas.width = buffer.width;
	canvas.height = buffer.height;
	const context = canvas.getContext('2d', {willReadFrequently: true});
	if (!context) return null;
	context.putImageData(new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height), 0, 0);
	return canvas;
};

const paintCanvas = (canvas: HTMLCanvasElement, buffer: PixelBuffer) => {
	const context = canvas.getContext('2d', {willReadFrequently: true});
	if (!context || canvas.width !== buffer.width || canvas.height !== buffer.height) return canvasFrom(buffer);
	context.putImageData(new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height), 0, 0);
	return canvas;
};

const copyBuffer = (buffer: PixelBuffer): PixelBuffer => ({
	width: buffer.width,
	height: buffer.height,
	data: new Uint8ClampedArray(buffer.data),
});

export const getBrushPreviewRevision = () => revision;

export const subscribeBrushPreview = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** Pixels the brush last committed or decoded for this asset. */
export const brushSourcePixels = (assetId: string) => sources.get(assetId)?.buffer;

/** Live stroke, shown in place of the asset until the stroke commits or cancels. */
export const brushPreviewPixels = (assetId: string) => overrides.get(assetId)?.buffer;

export const brushPreviewSource = (assetId: string): CanvasImageSource | undefined =>
	overrides.get(assetId)?.canvas ?? undefined;

export const brushSourceCanvas = (assetId: string): CanvasImageSource | undefined =>
	sources.get(assetId)?.canvas ?? undefined;

export const rememberBrushPixels = (assetId: string, buffer: PixelBuffer) => {
	const stored = copyBuffer(buffer);
	sources.set(assetId, {buffer: stored, canvas: canvasFrom(stored)});
};

/**
 * Decode a loaded image into the brush cache. The first decode wins, so a stroke
 * committed under the same id is not replaced when the element finishes loading.
 */
export const noteLoadedRaster = (assetId: string, source: CanvasImageSource, width: number, height: number) => {
	if (!assetId || sources.has(assetId) || typeof document === 'undefined' || width < 1 || height < 1) return;
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d', {willReadFrequently: true});
	if (!context) return;
	context.drawImage(source, 0, 0, width, height);
	const image = context.getImageData(0, 0, width, height);
	sources.set(assetId, {buffer: {width, height, data: image.data}, canvas});
};

/**
 * Pixels a stroke can start from. A real URL that has not decoded yet returns null
 * so the press can say the image is still loading instead of painting on empty pixels.
 */
export const resolveBrushPixels = (asset: AssetRecord): PixelBuffer | null => {
	const cached = sources.get(asset.id)?.buffer;
	if (cached) return copyBuffer(cached);
	const width = asset.width ?? 0;
	const height = asset.height ?? 0;
	if (width < 1 || height < 1) return null;
	if (!asset.objectKey || asset.objectKey.startsWith('memory://')) return createPixelBuffer(width, height);
	return null;
};

export const setBrushOverride = (assetId: string, buffer: PixelBuffer) => {
	const existing = overrides.get(assetId);
	if (existing?.buffer === buffer && existing.canvas) paintCanvas(existing.canvas, buffer);
	else overrides.set(assetId, {buffer, canvas: canvasFrom(buffer)});
	emit();
};

export const clearBrushOverride = (assetId: string) => {
	if (!overrides.delete(assetId)) return;
	emit();
};

const assetId = () =>
	`brush-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

export const rasterAssetFromPixels = (buffer: PixelBuffer, id = assetId()): AssetRecord => {
	rememberBrushPixels(id, buffer);
	const canvas = sources.get(id)?.canvas ?? null;
	let objectKey = `memory://${id}`;
	if (canvas) {
		try {
			objectKey = canvas.toDataURL('image/png');
		} catch {
			objectKey = `memory://${id}`;
		}
	}
	return {
		id,
		kind: 'raster',
		originalName: `${id}.png`,
		mimeType: 'image/png',
		width: buffer.width,
		height: buffer.height,
		byteSize: buffer.data.byteLength,
		objectKey,
		contentHash: hashPixels(buffer.data),
	};
};

export const resetBrushPixels = () => {
	sources.clear();
	overrides.clear();
	emit();
};
