export type Point = {x: number; y: number; pressure?: number};

export type ViewportSize = {width: number; height: number};

/**
 * Camera state is expressed in CSS pixels. The device pixel ratio is only
 * used by backing stores (overlay/GPU canvases), never by document mapping.
 */
export type ViewportTransform = {
	zoom: number;
	panX: number;
	panY: number;
	/** Rotation is intentionally disabled until affine hit testing is enabled. */
	rotation: 0;
	devicePixelRatio: number;
};

export type ViewportSnapshot = {
	viewport: ViewportSize;
	document: ViewportSize;
	transform: ViewportTransform;
	followsFit: boolean;
	/** CSS points per document pixel. DPR is deliberately excluded. */
	pointsPerPixel: number;
};
