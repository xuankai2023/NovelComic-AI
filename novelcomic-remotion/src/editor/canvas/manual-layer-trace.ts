import type {
	ManualLayerCanvas,
	ManualLayerPoint,
} from '../comic/manual-layer-types';
import type {LayerBounds} from '../comic/types';

export const MIN_TRACE_POINTS = 3;
export const DEFAULT_TRACE_CLOSE_THRESHOLD = 12;
const MIN_POLYGON_AREA = 0.5;

export type TracePolygonValidation =
	| {
			valid: true;
			bounds: LayerBounds;
	  }
	| {
			valid: false;
			reason: string;
	  };

const isFinitePoint = (point: ManualLayerPoint): boolean => {
	return Number.isFinite(point.x) && Number.isFinite(point.y);
};

const isValidCanvas = (canvas: ManualLayerCanvas): boolean => {
	return (
		Number.isFinite(canvas.width) &&
		Number.isFinite(canvas.height) &&
		canvas.width > 0 &&
		canvas.height > 0
	);
};

export const clampPointToCanvas = (
	point: ManualLayerPoint,
	canvas: ManualLayerCanvas,
): ManualLayerPoint => {
	if (!isValidCanvas(canvas)) {
		throw new Error('Trace canvas must have positive finite dimensions');
	}

	if (!isFinitePoint(point)) {
		throw new Error('Trace point must have finite coordinates');
	}

	return {
		x: Math.min(canvas.width, Math.max(0, point.x)),
		y: Math.min(canvas.height, Math.max(0, point.y)),
	};
};

export const getPointDistance = (
	first: ManualLayerPoint,
	second: ManualLayerPoint,
): number => {
	if (!isFinitePoint(first) || !isFinitePoint(second)) {
		throw new Error('Trace points must have finite coordinates');
	}

	return Math.hypot(first.x - second.x, first.y - second.y);
};

export const isNearPoint = (
	first: ManualLayerPoint,
	second: ManualLayerPoint,
	threshold = DEFAULT_TRACE_CLOSE_THRESHOLD,
): boolean => {
	if (!Number.isFinite(threshold) || threshold < 0) {
		throw new Error('Trace threshold must be a finite non-negative number');
	}

	return getPointDistance(first, second) <= threshold;
};

export const canClosePolygon = (
	points: readonly ManualLayerPoint[],
	candidate: ManualLayerPoint,
	threshold = DEFAULT_TRACE_CLOSE_THRESHOLD,
): boolean => {
	return (
		points.length >= MIN_TRACE_POINTS &&
		isNearPoint(points[0]!, candidate, threshold)
	);
};

export const addTracePoint = (
	points: readonly ManualLayerPoint[],
	point: ManualLayerPoint,
	canvas: ManualLayerCanvas,
): ManualLayerPoint[] => {
	return [...points, clampPointToCanvas(point, canvas)];
};

export const moveTracePoint = (
	points: readonly ManualLayerPoint[],
	index: number,
	point: ManualLayerPoint,
	canvas: ManualLayerCanvas,
): ManualLayerPoint[] => {
	if (index < 0 || index >= points.length) {
		return [...points];
	}

	const nextPoints = [...points];
	nextPoints[index] = clampPointToCanvas(point, canvas);
	return nextPoints;
};

export const removeTracePoint = (
	points: readonly ManualLayerPoint[],
	index: number,
): ManualLayerPoint[] => {
	if (index < 0 || index >= points.length) {
		return [...points];
	}

	return points.filter((_, candidateIndex) => candidateIndex !== index);
};

export const getTraceBounds = (
	points: readonly ManualLayerPoint[],
): LayerBounds | null => {
	if (points.length === 0) {
		return null;
	}

	for (const point of points) {
		if (!isFinitePoint(point)) {
			throw new Error('Trace point must have finite coordinates');
		}
	}

	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const left = Math.min(...xs);
	const right = Math.max(...xs);
	const top = Math.min(...ys);
	const bottom = Math.max(...ys);

	return {
		x: left,
		y: top,
		width: right - left,
		height: bottom - top,
	};
};

export const getTracePolygonArea = (
	points: readonly ManualLayerPoint[],
): number => {
	if (points.length < MIN_TRACE_POINTS) {
		return 0;
	}

	let area = 0;
	for (let index = 0; index < points.length; index++) {
		const current = points[index]!;
		const next = points[(index + 1) % points.length]!;
		if (!isFinitePoint(current) || !isFinitePoint(next)) {
			throw new Error('Trace point must have finite coordinates');
		}
		area += current.x * next.y - next.x * current.y;
	}

	return Math.abs(area) / 2;
};

export const validateTracePolygon = (
	points: readonly ManualLayerPoint[],
	canvas: ManualLayerCanvas,
): TracePolygonValidation => {
	if (!isValidCanvas(canvas)) {
		return {
			valid: false,
			reason: 'Trace canvas must have positive finite dimensions',
		};
	}

	if (points.length < MIN_TRACE_POINTS) {
		return {
			valid: false,
			reason: `Trace polygon needs at least ${MIN_TRACE_POINTS} points`,
		};
	}

	for (const point of points) {
		if (!isFinitePoint(point)) {
			return {
				valid: false,
				reason: 'Trace polygon point must have finite coordinates',
			};
		}

		if (
			point.x < 0 ||
			point.y < 0 ||
			point.x > canvas.width ||
			point.y > canvas.height
		) {
			return {
				valid: false,
				reason: 'Trace polygon point is outside the canvas',
			};
		}
	}

	const bounds = getTraceBounds(points);
	if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
		return {
			valid: false,
			reason: 'Trace polygon needs non-zero bounds',
		};
	}

	if (getTracePolygonArea(points) <= MIN_POLYGON_AREA) {
		return {
			valid: false,
			reason: 'Trace polygon needs non-zero area',
		};
	}

	return {
		valid: true,
		bounds,
	};
};
