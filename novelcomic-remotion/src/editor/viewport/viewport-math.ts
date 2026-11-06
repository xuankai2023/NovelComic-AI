import type {Point, ViewportSize, ViewportTransform} from './viewport-types';

export const documentRect = (
	viewport: ViewportSize,
	document: ViewportSize,
	transform: ViewportTransform,
) => {
	return {
		left:
			viewport.width / 2 +
			transform.panX -
			(document.width * transform.zoom) / 2,
		top:
			viewport.height / 2 +
			transform.panY -
			(document.height * transform.zoom) / 2,
		width: document.width * transform.zoom,
		height: document.height * transform.zoom,
	};
};

export const screenToDocument = (
	point: Point,
	viewport: ViewportSize,
	document: ViewportSize,
	transform: ViewportTransform,
): Point => {
	const rect = documentRect(viewport, document, transform);
	return {
		x: (point.x - rect.left) / transform.zoom,
		y: (point.y - rect.top) / transform.zoom,
	};
};

export const documentToScreen = (
	point: Point,
	viewport: ViewportSize,
	document: ViewportSize,
	transform: ViewportTransform,
): Point => {
	const rect = documentRect(viewport, document, transform);
	return {
		x: rect.left + point.x * transform.zoom,
		y: rect.top + point.y * transform.zoom,
	};
};
