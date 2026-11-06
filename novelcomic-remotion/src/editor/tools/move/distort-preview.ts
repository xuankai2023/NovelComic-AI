import type {ToolPoint} from '../types';

export type WarpCorners = [ToolPoint, ToolPoint, ToolPoint, ToolPoint];

const warps = new Map<string, WarpCorners>();

export const setLayerWarp = (layerId: string, corners: WarpCorners | null) => {
	if (corners) warps.set(layerId, corners);
	else warps.delete(layerId);
};

export const clearLayerWarps = () => {
	warps.clear();
};

export const layerWarp = (layerId: string) => warps.get(layerId);

const triangleMatrix = (
	sx0: number,
	sy0: number,
	sx1: number,
	sy1: number,
	sx2: number,
	sy2: number,
	dx0: number,
	dy0: number,
	dx1: number,
	dy1: number,
	dx2: number,
	dy2: number,
) => {
	const denominator = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
	if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-6) return null;
	return {
		a: (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denominator,
		b: (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denominator,
		c: (sx0 * (dx1 - dx2) + sx1 * (dx2 - dx0) + sx2 * (dx0 - dx1)) / denominator,
		d: (sx0 * (dy1 - dy2) + sx1 * (dy2 - dy0) + sx2 * (dy0 - dy1)) / denominator,
		e:
			(sx0 * (sy1 * dx2 - sy2 * dx1) +
				sx1 * (sy2 * dx0 - sy0 * dx2) +
				sx2 * (sy0 * dx1 - sy1 * dx0)) /
			denominator,
		f:
			(sx0 * (sy1 * dy2 - sy2 * dy1) +
				sx1 * (sy2 * dy0 - sy0 * dy2) +
				sx2 * (sy0 * dy1 - sy1 * dy0)) /
			denominator,
	};
};

const drawTriangle = (
	context: CanvasRenderingContext2D,
	image: CanvasImageSource,
	contentWidth: number,
	contentHeight: number,
	source: [ToolPoint, ToolPoint, ToolPoint],
	destination: [ToolPoint, ToolPoint, ToolPoint],
) => {
	const matrix = triangleMatrix(
		source[0].x,
		source[0].y,
		source[1].x,
		source[1].y,
		source[2].x,
		source[2].y,
		destination[0].x,
		destination[0].y,
		destination[1].x,
		destination[1].y,
		destination[2].x,
		destination[2].y,
	);
	if (!matrix) return;
	context.save();
	context.beginPath();
	context.moveTo(destination[0].x, destination[0].y);
	context.lineTo(destination[1].x, destination[1].y);
	context.lineTo(destination[2].x, destination[2].y);
	context.closePath();
	context.clip();
	context.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
	context.drawImage(image, 0, 0, contentWidth, contentHeight);
	context.restore();
};

/** Draw a layer into an arbitrary quad. Two triangles cover a folded shape as well as a convex one. */
export const drawWarpedImage = (
	context: CanvasRenderingContext2D,
	image: CanvasImageSource,
	contentWidth: number,
	contentHeight: number,
	corners: WarpCorners,
) => {
	const source: ToolPoint[] = [
		{x: 0, y: 0},
		{x: contentWidth, y: 0},
		{x: contentWidth, y: contentHeight},
		{x: 0, y: contentHeight},
	];
	drawTriangle(
		context,
		image,
		contentWidth,
		contentHeight,
		[source[0], source[1], source[2]],
		[corners[0], corners[1], corners[2]],
	);
	drawTriangle(
		context,
		image,
		contentWidth,
		contentHeight,
		[source[0], source[2], source[3]],
		[corners[0], corners[2], corners[3]],
	);
};
