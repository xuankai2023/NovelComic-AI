import type {DocumentState, LayerTransform} from './types';

export type DocumentBounds = {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
	centerX: number;
	centerY: number;
};

const finite = (value: number) => Number.isFinite(value);

/** Returns the axis-aligned document-space bounds of a layer transform. */
export const getTransformBounds = (transform: LayerTransform): DocumentBounds => {
	const width = Math.abs(transform.width * transform.scaleX);
	const height = Math.abs(transform.height * transform.scaleY);
	const angle = (transform.rotation * Math.PI) / 180;
	const cos = Math.abs(Math.cos(angle));
	const sin = Math.abs(Math.sin(angle));
	const boundsWidth = width * cos + height * sin;
	const boundsHeight = width * sin + height * cos;
	const centerX = transform.originX + width / 2;
	const centerY = transform.originY + height / 2;
	return {left: centerX - boundsWidth / 2, top: centerY - boundsHeight / 2, right: centerX + boundsWidth / 2, bottom: centerY + boundsHeight / 2, width: boundsWidth, height: boundsHeight, centerX, centerY};
};

export const getLayerBounds = (document: DocumentState, layerId: string): DocumentBounds | null => {
	const layer = document.layers[layerId];
	return layer ? getTransformBounds(layer.transform) : null;
};

export const isValidTransform = (transform: LayerTransform): boolean =>
	Object.values(transform).every((value) => typeof value === 'string' || finite(value as number)) &&
	transform.width > 0 && transform.height > 0 && transform.scaleX !== 0 && transform.scaleY !== 0 &&
	['high', 'smooth', 'nearest'].includes(transform.sampling);

export const translateTransform = (transform: LayerTransform, dx: number, dy: number): LayerTransform => ({...transform, originX: transform.originX + dx, originY: transform.originY + dy});
export const resizeTransform = (transform: LayerTransform, width: number, height: number, anchor: 'top-left' | 'center' = 'top-left'): LayerTransform => {
	const nextWidth = Math.max(0.01, width);
	const nextHeight = Math.max(0.01, height);
	if (anchor === 'center') return {...transform, width: nextWidth, height: nextHeight, originX: transform.originX + (transform.width - nextWidth) / 2, originY: transform.originY + (transform.height - nextHeight) / 2};
	return {...transform, width: nextWidth, height: nextHeight};
};
export const rotateTransform = (transform: LayerTransform, rotation: number): LayerTransform => ({...transform, rotation});
export const flipTransform = (transform: LayerTransform, axis: 'x' | 'y'): LayerTransform => axis === 'x' ? {...transform, scaleX: -transform.scaleX} : {...transform, scaleY: -transform.scaleY};

export const transformDocumentLayers = (document: DocumentState, transforms: Record<string, LayerTransform>): DocumentState => {
	const layers = {...document.layers};
	for (const [id, transform] of Object.entries(transforms)) {
		const layer = layers[id];
		if (!layer || layer.locked || !isValidTransform(transform)) continue;
		layers[id] = {...layer, transform: {...transform}};
	}
	return {...document, layers};
};

export const transformsForTranslation = (document: DocumentState, layerIds: readonly string[], dx: number, dy: number): Record<string, LayerTransform> => Object.fromEntries(layerIds.flatMap((id) => { const layer = document.layers[id]; return layer && !layer.locked ? [[id, translateTransform(layer.transform, dx, dy)]] : []; }));
