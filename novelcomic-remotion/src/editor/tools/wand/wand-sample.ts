import type {DocumentState, LayerNode} from '../../document/types';
import {evaluateDocumentFrame} from '../../render-graph/evaluate-document-frame';
import {createPixelBuffer, type PixelBuffer} from '../../pixels/pixel-tools';
import type {EvaluatedLayerTransform} from '../../render-graph/types';

const transparent = (width: number, height: number) => createPixelBuffer(width, height);

/** Straight RGBA from a canvas becomes the premultiplied bytes `wand_mask` compares. */
export const premultiplyBuffer = (source: PixelBuffer): PixelBuffer => {
	const data = new Uint8ClampedArray(source.data.length);
	for (let index = 0; index < source.data.length; index += 4) {
		const alpha = source.data[index + 3]!;
		data[index] = Math.floor((source.data[index]! * alpha + 127) / 255);
		data[index + 1] = Math.floor((source.data[index + 1]! * alpha + 127) / 255);
		data[index + 2] = Math.floor((source.data[index + 2]! * alpha + 127) / 255);
		data[index + 3] = alpha;
	}
	return {width: source.width, height: source.height, data};
};

const placedSize = (transform: {width: number; height: number; scaleX: number; scaleY: number}) => ({
	width: Math.abs(transform.width * transform.scaleX),
	height: Math.abs(transform.height * transform.scaleY),
});

const uprightCopy = (
	documentWidth: number,
	documentHeight: number,
	image: PixelBuffer,
	transform: EvaluatedLayerTransform,
	opacity: number,
) => {
	if (transform.rotation !== 0 || transform.scaleX !== 1 || transform.scaleY !== 1) return null;
	if (!Number.isInteger(transform.x) || !Number.isInteger(transform.y)) return null;
	if (image.width !== transform.width || image.height !== transform.height) return null;
	const dest = transparent(documentWidth, documentHeight);
	const originX = transform.x;
	const originY = transform.y;
	for (let y = 0; y < image.height; y++) {
		const documentY = originY + y;
		if (documentY < 0 || documentY >= documentHeight) continue;
		for (let x = 0; x < image.width; x++) {
			const documentX = originX + x;
			if (documentX < 0 || documentX >= documentWidth) continue;
			const from = (y * image.width + x) * 4;
			const alpha = Math.round(image.data[from + 3]! * opacity);
			const to = (documentY * documentWidth + documentX) * 4;
			dest.data[to] = Math.floor((image.data[from]! * alpha + 127) / 255);
			dest.data[to + 1] = Math.floor((image.data[from + 1]! * alpha + 127) / 255);
			dest.data[to + 2] = Math.floor((image.data[from + 2]! * alpha + 127) / 255);
			dest.data[to + 3] = alpha;
		}
	}
	return dest;
};

const drawPlaced = (
	documentWidth: number,
	documentHeight: number,
	image: PixelBuffer,
	transform: EvaluatedLayerTransform,
	opacity: number,
) => {
	const copied = uprightCopy(documentWidth, documentHeight, image, transform, opacity);
	if (copied) return copied;
	if (typeof document === 'undefined') return null;
	const source = document.createElement('canvas');
	source.width = image.width;
	source.height = image.height;
	const sourceContext = source.getContext('2d');
	const dest = document.createElement('canvas');
	dest.width = documentWidth;
	dest.height = documentHeight;
	const context = dest.getContext('2d', {willReadFrequently: true});
	if (!sourceContext || !context) return null;
	sourceContext.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
	const placed = placedSize(transform);
	context.save();
	context.globalAlpha = Math.max(0, Math.min(1, opacity));
	context.translate(transform.x + placed.width / 2, transform.y + placed.height / 2);
	context.rotate((transform.rotation * Math.PI) / 180);
	context.scale(transform.scaleX, transform.scaleY);
	context.translate(-transform.width / 2, -transform.height / 2);
	context.imageSmoothingEnabled = transform.sampling !== 'nearest';
	context.drawImage(source, 0, 0, transform.width, transform.height);
	context.restore();
	return premultiplyBuffer({width: documentWidth, height: documentHeight, data: context.getImageData(0, 0, documentWidth, documentHeight).data});
};

const sourceOver = (dest: PixelBuffer, source: PixelBuffer) => {
	for (let index = 0; index < dest.data.length; index += 4) {
		const alpha = source.data[index + 3]!;
		if (!alpha) continue;
		const inverse = (255 - alpha) / 255;
		dest.data[index] = Math.round(source.data[index]! + dest.data[index]! * inverse);
		dest.data[index + 1] = Math.round(source.data[index + 1]! + dest.data[index + 1]! * inverse);
		dest.data[index + 2] = Math.round(source.data[index + 2]! + dest.data[index + 2]! * inverse);
		dest.data[index + 3] = Math.round(alpha + dest.data[index + 3]! * inverse);
	}
};

const worldTransform = (document: DocumentState, layer: LayerNode): EvaluatedLayerTransform | null => {
	const frame = evaluateDocumentFrame({document});
	return frame.layers.find((entry) => entry.id === layer.id)?.transform ?? null;
};

/**
 * What the wand reads, at document size. All Layers is the visible composite.
 * This Layer is the active layer's own pixels, without its mask. A folder, text,
 * shape, adjustment, or blank layer reads as transparent.
 * Pixel buffers from `pixelsOf` and `composite` are straight RGBA.
 */
export const sampleWandImage = (
	document: DocumentState,
	activeLayerId: string | null,
	sampleAllLayers: boolean,
	pixelsOf: (assetId: string) => PixelBuffer | null,
	composite: PixelBuffer | null,
): PixelBuffer | null => {
	if (sampleAllLayers && composite && composite.width === document.width && composite.height === document.height) {
		return premultiplyBuffer(composite);
	}
	if (sampleAllLayers) {
		const frame = evaluateDocumentFrame({document});
		const dest = transparent(document.width, document.height);
		let sawPixels = false;
		let missing = false;
		for (const node of frame.nodes) {
			if (node.kind !== 'layer' || !node.layer.visible || node.layer.content.kind !== 'pixel') continue;
			const image = pixelsOf(node.layer.content.assetId);
			if (!image) {
				const asset = document.assets[node.layer.content.assetId];
				if (asset?.objectKey && !asset.objectKey.startsWith('memory://')) missing = true;
				continue;
			}
			const placed = drawPlaced(document.width, document.height, image, node.layer.transform, node.layer.opacity);
			if (!placed) return null;
			sourceOver(dest, placed);
			sawPixels = true;
		}
		if (missing && !sawPixels) return null;
		return dest;
	}
	const layer = activeLayerId ? document.layers[activeLayerId] : undefined;
	if (!layer || layer.kind === 'group' || layer.content.kind !== 'pixel') return transparent(document.width, document.height);
	const image = pixelsOf(layer.content.assetId);
	if (!image) {
		const asset = document.assets[layer.content.assetId];
		if (!asset?.objectKey || asset.objectKey.startsWith('memory://')) return transparent(document.width, document.height);
		return null;
	}
	const transform = worldTransform(document, layer);
	if (!transform) return null;
	return drawPlaced(document.width, document.height, image, transform, 1);
};
