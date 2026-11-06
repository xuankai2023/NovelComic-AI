import type {AssetRecord, DocumentState, LayerNode, LayerTransform} from '../document/types';
import type {ViewportSnapshot} from '../viewport/viewport-types';
import {documentToScreen, screenToDocument} from '../viewport/viewport-math';
import type {ToolPoint} from './types';

export type {ToolPoint};

export type Affine2D = {a: number; b: number; c: number; d: number; e: number; f: number};
export const identityAffine: Affine2D = {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0};
export const multiplyAffine = (left: Affine2D, right: Affine2D): Affine2D => ({a: left.a * right.a + left.c * right.b, b: left.b * right.a + left.d * right.b, c: left.a * right.c + left.c * right.d, d: left.b * right.c + left.d * right.d, e: left.a * right.e + left.c * right.f + left.e, f: left.b * right.e + left.d * right.f + left.f});
export const invertAffine = (matrix: Affine2D): Affine2D | null => {
	const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
	if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
	return {a: matrix.d / determinant, b: -matrix.b / determinant, c: -matrix.c / determinant, d: matrix.a / determinant, e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant, f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant};
};
export const transformPoint = (matrix: Affine2D, point: ToolPoint): ToolPoint => ({x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f});

export const layerLocalMatrix = (transform: LayerTransform): Affine2D | null => {
	if (![transform.originX, transform.originY, transform.width, transform.height, transform.rotation, transform.scaleX, transform.scaleY].every(Number.isFinite) || transform.scaleX === 0 || transform.scaleY === 0 || transform.width === 0 || transform.height === 0) return null;
	// Rotation is clockwise around the box center, matching Move / Transform.
	// Flips stay inside that box instead of reflecting across the top-left.
	const radians = (transform.rotation * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const placedWidth = Math.abs(transform.width * transform.scaleX);
	const placedHeight = Math.abs(transform.height * transform.scaleY);
	const centerX = transform.originX + placedWidth / 2;
	const centerY = transform.originY + placedHeight / 2;
	const a = cos * transform.scaleX;
	const b = sin * transform.scaleX;
	const c = -sin * transform.scaleY;
	const d = cos * transform.scaleY;
	return {
		a,
		b,
		c,
		d,
		e: centerX - (a * transform.width) / 2 - (c * transform.height) / 2,
		f: centerY - (b * transform.width) / 2 - (d * transform.height) / 2,
	};
};

type AnimatedProperty = 'x' | 'y' | 'width' | 'height' | 'rotation' | 'scaleX' | 'scaleY';
const animatedValue = (layer: LayerNode, property: AnimatedProperty, base: number, frame: number) => {
	const track = layer.animation?.properties[property];
	if (!track?.keyframes.length) return base;
	const keyframes = track.keyframes.slice().sort((left, right) => left.frame - right.frame);
	if (frame <= keyframes[0]!.frame) return keyframes[0]!.value;
	for (let index = 1; index < keyframes.length; index += 1) {
		const previous = keyframes[index - 1]!;
		const next = keyframes[index]!;
		if (frame <= next.frame) {
			const raw = (frame - previous.frame) / Math.max(1, next.frame - previous.frame);
			const progress = next.easing === 'hold' ? 0 : next.easing === 'ease-in' ? raw * raw : next.easing === 'ease-out' ? 1 - (1 - raw) ** 2 : next.easing === 'ease-in-out' ? (raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2) : raw;
			return previous.value + (next.value - previous.value) * Math.min(1, Math.max(0, progress));
		}
	}
	return keyframes.at(-1)!.value;
};

const layerMatrixAtFrame = (layer: LayerNode, frame: number): Affine2D | null =>
	layerLocalMatrix({
		...layer.transform,
		originX: animatedValue(layer, 'x', layer.transform.originX, frame),
		originY: animatedValue(layer, 'y', layer.transform.originY, frame),
		width: animatedValue(layer, 'width', layer.transform.width, frame),
		height: animatedValue(layer, 'height', layer.transform.height, frame),
		rotation: animatedValue(layer, 'rotation', layer.transform.rotation, frame),
		scaleX: animatedValue(layer, 'scaleX', layer.transform.scaleX, frame),
		scaleY: animatedValue(layer, 'scaleY', layer.transform.scaleY, frame),
	});

export const layerWorldMatrix = (document: DocumentState, layerId: string, _frame = 0): Affine2D | null => {
	const frame = _frame;
	const visiting = new Set<string>();
	const visit = (id: string): Affine2D | null => {
		const layer = document.layers[id];
		if (!layer || visiting.has(id)) return null;
		visiting.add(id);
		const parent = layer.parentId ? visit(layer.parentId) : identityAffine;
		visiting.delete(id);
		const local = layerMatrixAtFrame(layer, frame);
		return parent && local ? multiplyAffine(parent, local) : null;
	};
	return visit(layerId);
};
export const clientToViewport = (point: ToolPoint, viewportRect: DOMRectReadOnly): ToolPoint => ({x: point.x - viewportRect.left, y: point.y - viewportRect.top});
export const viewportToDocument = (point: ToolPoint, snapshot: ViewportSnapshot): ToolPoint => screenToDocument(point, snapshot.viewport, snapshot.document, snapshot.transform);
export const documentToViewport = (point: ToolPoint, snapshot: ViewportSnapshot): ToolPoint => documentToScreen(point, snapshot.viewport, snapshot.document, snapshot.transform);
export const documentToLayer = (point: ToolPoint, document: DocumentState, layerId: string, frame = 0): ToolPoint | null => { const matrix = layerWorldMatrix(document, layerId, frame); const inverse = matrix && invertAffine(matrix); return inverse ? transformPoint(inverse, point) : null; };
export const layerToDocument = (point: ToolPoint, document: DocumentState, layerId: string, frame = 0): ToolPoint | null => { const matrix = layerWorldMatrix(document, layerId, frame); return matrix ? transformPoint(matrix, point) : null; };
export const layerToAssetPixel = (point: ToolPoint, layer: LayerNode, asset: AssetRecord): ToolPoint | null => {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !asset.width || !asset.height || !layer.transform.width || !layer.transform.height) return null;
	return {x: point.x * asset.width / layer.transform.width, y: point.y * asset.height / layer.transform.height};
};
