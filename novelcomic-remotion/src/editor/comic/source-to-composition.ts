import type {ManualLayerCanvas, ManualLayerPoint} from './manual-layer-types';
import type {LayerBounds} from './types';

export type CompositionCanvas = ManualLayerCanvas;

const assertValidCanvas = (canvas: ManualLayerCanvas, label: string): void => {
	if (
		!Number.isFinite(canvas.width) ||
		!Number.isFinite(canvas.height) ||
		canvas.width <= 0 ||
		canvas.height <= 0
	) {
		throw new Error(`${label} must have positive finite dimensions`);
	}
};

const assertFinitePoint = (point: ManualLayerPoint, label: string): void => {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
		throw new Error(`${label} must have finite coordinates`);
	}
};

const assertFiniteBounds = (bounds: LayerBounds, label: string): void => {
	if (
		!Number.isFinite(bounds.x) ||
		!Number.isFinite(bounds.y) ||
		!Number.isFinite(bounds.width) ||
		!Number.isFinite(bounds.height)
	) {
		throw new Error(`${label} must have finite geometry`);
	}
};

export const getSourceToCompositionScale = (
	sourceCanvas: ManualLayerCanvas,
	compositionCanvas: CompositionCanvas,
): ManualLayerPoint => {
	assertValidCanvas(sourceCanvas, 'sourceCanvas');
	assertValidCanvas(compositionCanvas, 'compositionCanvas');

	return {
		x: compositionCanvas.width / sourceCanvas.width,
		y: compositionCanvas.height / sourceCanvas.height,
	};
};

export const sourcePointToComposition = (
	point: ManualLayerPoint,
	sourceCanvas: ManualLayerCanvas,
	compositionCanvas: CompositionCanvas,
): ManualLayerPoint => {
	assertFinitePoint(point, 'source point');
	const scale = getSourceToCompositionScale(sourceCanvas, compositionCanvas);

	return {
		x: point.x * scale.x,
		y: point.y * scale.y,
	};
};

export const sourcePolygonToComposition = (
	polygon: readonly ManualLayerPoint[],
	sourceCanvas: ManualLayerCanvas,
	compositionCanvas: CompositionCanvas,
): ManualLayerPoint[] => {
	return polygon.map((point) => {
		return sourcePointToComposition(point, sourceCanvas, compositionCanvas);
	});
};

export const sourceBoundsToComposition = (
	bounds: LayerBounds,
	sourceCanvas: ManualLayerCanvas,
	compositionCanvas: CompositionCanvas,
): LayerBounds => {
	assertFiniteBounds(bounds, 'source bounds');
	const scale = getSourceToCompositionScale(sourceCanvas, compositionCanvas);

	return {
		x: bounds.x * scale.x,
		y: bounds.y * scale.y,
		width: bounds.width * scale.x,
		height: bounds.height * scale.y,
	};
};
