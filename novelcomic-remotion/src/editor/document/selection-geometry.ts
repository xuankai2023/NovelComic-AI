import type {DocumentState, SelectionRecord, SelectionRect, SelectionShape} from './types';
import {getLayerBounds} from './transform';

export const ACTIVE_SELECTION_ID = 'active-selection';
/** Screen points at which a marquee corner or a moved edge snaps. Matches TransformSnap.distance. */
export const MARQUEE_SNAP_DISTANCE = 10;

export type MarqueeMode = 'replace' | 'add' | 'subtract';
export type MarqueeOutline = 'rectangle' | 'ellipse';
export type SelectionPoint = {x: number; y: number};
export type SelectionFigure =
	| {kind: 'path'; d: string}
	| {kind: 'ellipse'; bounds: SelectionRect};
export type SnapGuide = {orientation: 'horizontal' | 'vertical'; position: number};

const ZERO: SelectionRect = {x: 0, y: 0, width: 0, height: 0};

/** Half away from zero, matching Swift's `rounded()`. */
export const roundWhole = (value: number) =>
	(value < 0 ? -1 : 1) * Math.round(Math.abs(value));

/**
 * The box a drag from `anchor` to `point` spans, in whole pixels.
 * `square` evens the sides. `fromCenter` grows the box around the anchor.
 */
export const dragBox = (
	anchor: SelectionPoint,
	point: SelectionPoint,
	square: boolean,
	fromCenter: boolean,
): SelectionRect => {
	let dx = roundWhole(point.x) - anchor.x;
	let dy = roundWhole(point.y) - anchor.y;
	if (square) {
		const side = Math.max(Math.abs(dx), Math.abs(dy));
		dx = dx < 0 ? -side : side;
		dy = dy < 0 ? -side : side;
	}
	const width = Math.abs(dx);
	const height = Math.abs(dy);
	if (fromCenter) {
		return {x: anchor.x - width, y: anchor.y - height, width: width * 2, height: height * 2};
	}
	return {
		x: Math.min(anchor.x, anchor.x + dx),
		y: Math.min(anchor.y, anchor.y + dy),
		width,
		height,
	};
};

export const rectArea = (rect: SelectionRect) =>
	Math.max(0, rect.width) * Math.max(0, rect.height);

export const isEmptyShape = (shape: SelectionShape | null | undefined): boolean => {
	if (!shape || shape.kind === 'empty') return true;
	if (shape.kind === 'rect' || shape.kind === 'ellipse') return rectArea(shape.bounds) <= 0;
	if (shape.kind === 'polygon') return shape.points.length < 3 || rectArea(boundsOfPoints(shape.points) ?? ZERO) <= 0;
	if (shape.kind === 'rects') return shape.rects.every((rect) => rectArea(rect) <= 0);
	if (shape.kind === 'union') return shape.shapes.every((entry) => isEmptyShape(entry));
	return isEmptyShape(shape.base);
};

export const shapeBounds = (shape: SelectionShape | null | undefined): SelectionRect | null => {
	if (!shape || isEmptyShape(shape)) return null;
	if (shape.kind === 'rect' || shape.kind === 'ellipse') return {...shape.bounds};
	if (shape.kind === 'polygon') return boundsOfPoints(shape.points);
	if (shape.kind === 'rects') return boundsOfRects(shape.rects);
	if (shape.kind === 'union') return boundsOfRects(shape.shapes.map(shapeBounds).filter((entry): entry is SelectionRect => Boolean(entry)));
	if (shape.kind !== 'difference') return null;
	const base = shapeBounds(shape.base);
	const cut = shapeBounds(shape.cut);
	if (!base) return null;
	if (!cut) return base;
	return base;
};

const boundsOfPoints = (points: readonly SelectionPoint[]): SelectionRect | null => {
	if (!points.length) return null;
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return {x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y};
};

const boundsOfRects = (rects: readonly SelectionRect[]): SelectionRect | null => {
	const live = rects.filter((rect) => rectArea(rect) > 0);
	if (!live.length) return null;
	const x = Math.min(...live.map((rect) => rect.x));
	const y = Math.min(...live.map((rect) => rect.y));
	const right = Math.max(...live.map((rect) => rect.x + rect.width));
	const bottom = Math.max(...live.map((rect) => rect.y + rect.height));
	return {x, y, width: right - x, height: bottom - y};
};

export const containsPoint = (shape: SelectionShape | null | undefined, x: number, y: number): boolean => {
	if (!shape || shape.kind === 'empty') return false;
	if (shape.kind === 'rect') return pointInRect(shape.bounds, x, y);
	if (shape.kind === 'ellipse') return pointInEllipse(shape.bounds, x, y);
	if (shape.kind === 'polygon') return pointInPolygon(x, y, shape.points);
	if (shape.kind === 'rects') return shape.rects.some((rect) => pointInRect(rect, x, y));
	if (shape.kind === 'union') return shape.shapes.some((entry) => containsPoint(entry, x, y));
	return containsPoint(shape.base, x, y) && !containsPoint(shape.cut, x, y);
};

/**
 * Coverage 0–255 of the document pixel whose top-left is (`x`, `y`).
 * Antialiasing supersamples the pixel, the way Core Graphics fills a lasso with
 * `setShouldAntialias`. A hard edge is only the sample at the pixel center.
 */
export const selectionCoverage = (
	shape: SelectionShape | null | undefined,
	x: number,
	y: number,
	options?: {antialiased?: boolean},
) => {
	if (!options?.antialiased) return containsPoint(shape, x + 0.5, y + 0.5) ? 255 : 0;
	const samples = 4;
	let hits = 0;
	for (let iy = 0; iy < samples; iy++) {
		for (let ix = 0; ix < samples; ix++) {
			if (containsPoint(shape, x + (ix + 0.5) / samples, y + (iy + 0.5) / samples)) hits++;
		}
	}
	return Math.round((hits / (samples * samples)) * 255);
};

const pointInRect = (rect: SelectionRect, x: number, y: number) =>
	x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;

const pointInEllipse = (rect: SelectionRect, x: number, y: number) => {
	const rx = rect.width / 2;
	const ry = rect.height / 2;
	if (rx <= 0 || ry <= 0) return false;
	const cx = rect.x + rx;
	const cy = rect.y + ry;
	return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
};

/** Nonzero winding, matching `CGPath.contains(_:using: .winding)` and `fillPath(using: .winding)`. */
const pointInPolygon = (x: number, y: number, points: readonly SelectionPoint[]) => {
	let winding = 0;
	for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
		const start = points[previous];
		const end = points[index];
		if (!start || !end) continue;
		if (start.y <= y) {
			if (end.y > y && edgeSide(start, end, x, y) > 0) winding++;
		} else if (end.y <= y && edgeSide(start, end, x, y) < 0) winding--;
	}
	return winding !== 0;
};

const edgeSide = (start: SelectionPoint, end: SelectionPoint, x: number, y: number) =>
	(end.x - start.x) * (y - start.y) - (x - start.x) * (end.y - start.y);

export const translateShape = (shape: SelectionShape, dx: number, dy: number): SelectionShape => {
	if (!dx && !dy) return shape;
	if (shape.kind === 'empty') return shape;
	if (shape.kind === 'rect' || shape.kind === 'ellipse') return {...shape, bounds: translateRect(shape.bounds, dx, dy)};
	if (shape.kind === 'polygon') return {kind: 'polygon', points: shape.points.map((point) => ({x: point.x + dx, y: point.y + dy}))};
	if (shape.kind === 'rects') return {kind: 'rects', rects: shape.rects.map((rect) => translateRect(rect, dx, dy))};
	if (shape.kind === 'union') return {kind: 'union', shapes: shape.shapes.map((entry) => translateShape(entry, dx, dy))};
	return {kind: 'difference', base: translateShape(shape.base, dx, dy), cut: translateShape(shape.cut, dx, dy)};
};

const translateRect = (rect: SelectionRect, dx: number, dy: number): SelectionRect => ({
	...rect,
	x: rect.x + dx,
	y: rect.y + dy,
});

const intersection = (left: SelectionRect, right: SelectionRect): SelectionRect | null => {
	const x = Math.max(left.x, right.x);
	const y = Math.max(left.y, right.y);
	const rightEdge = Math.min(left.x + left.width, right.x + right.width);
	const bottom = Math.min(left.y + left.height, right.y + right.height);
	if (rightEdge - x <= 0 || bottom - y <= 0) return null;
	return {x, y, width: rightEdge - x, height: bottom - y};
};

const subtractOne = (source: SelectionRect, cut: SelectionRect): SelectionRect[] => {
	const overlap = intersection(source, cut);
	if (!overlap) return rectArea(source) > 0 ? [source] : [];
	const pieces: SelectionRect[] = [];
	const top = overlap.y - source.y;
	const bottom = source.y + source.height - (overlap.y + overlap.height);
	const left = overlap.x - source.x;
	const right = source.x + source.width - (overlap.x + overlap.width);
	if (top > 0) pieces.push({x: source.x, y: source.y, width: source.width, height: top});
	if (bottom > 0) pieces.push({x: source.x, y: overlap.y + overlap.height, width: source.width, height: bottom});
	if (left > 0) pieces.push({x: source.x, y: overlap.y, width: left, height: overlap.height});
	if (right > 0) pieces.push({x: overlap.x + overlap.width, y: overlap.y, width: right, height: overlap.height});
	return pieces.filter((piece) => rectArea(piece) > 0);
};

const subtractRects = (rects: readonly SelectionRect[], cut: SelectionRect) =>
	rects.flatMap((rect) => subtractOne(rect, cut));

const addRects = (rects: readonly SelectionRect[], addition: SelectionRect) => [
	...subtractRects(rects, addition),
	addition,
];

const shapeFromRects = (rects: readonly SelectionRect[]): SelectionShape => {
	const live = rects.filter((rect) => rectArea(rect) > 0);
	if (!live.length) return {kind: 'empty'};
	if (live.length === 1) return {kind: 'rect', bounds: live[0]!};
	return {kind: 'rects', rects: live};
};

const rectsOf = (shape: SelectionShape | null): SelectionRect[] | null => {
	if (!shape || shape.kind === 'empty') return [];
	if (shape.kind === 'rect') return [shape.bounds];
	if (shape.kind === 'rects') return shape.rects;
	return null;
};

const clipRect = (rect: SelectionRect, width: number, height: number): SelectionRect | null =>
	intersection(rect, {x: 0, y: 0, width, height});

const ellipsePoints = (rect: SelectionRect, count = 72): SelectionPoint[] => {
	const rx = rect.width / 2;
	const ry = rect.height / 2;
	const cx = rect.x + rx;
	const cy = rect.y + ry;
	return Array.from({length: count}, (_, index) => {
		const angle = (index / count) * Math.PI * 2;
		return {x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry};
	});
};

const clipPolygon = (points: SelectionPoint[], width: number, height: number): SelectionPoint[] => {
	const edges: Array<{inside: (point: SelectionPoint) => boolean; cross: (from: SelectionPoint, to: SelectionPoint) => SelectionPoint}> = [
		{inside: (point) => point.x >= 0, cross: (from, to) => ({x: 0, y: from.y + ((to.y - from.y) * (0 - from.x)) / (to.x - from.x)})},
		{inside: (point) => point.x <= width, cross: (from, to) => ({x: width, y: from.y + ((to.y - from.y) * (width - from.x)) / (to.x - from.x)})},
		{inside: (point) => point.y >= 0, cross: (from, to) => ({x: from.x + ((to.x - from.x) * (0 - from.y)) / (to.y - from.y), y: 0})},
		{inside: (point) => point.y <= height, cross: (from, to) => ({x: from.x + ((to.x - from.x) * (height - from.y)) / (to.y - from.y), y: height})},
	];
	let output = points;
	for (const edge of edges) {
		if (!output.length) return [];
		const input = output;
		output = [];
		for (let index = 0; index < input.length; index++) {
			const current = input[index]!;
			const previous = input[(index + input.length - 1) % input.length]!;
			const currentInside = edge.inside(current);
			const previousInside = edge.inside(previous);
			if (currentInside) {
				if (!previousInside) output.push(edge.cross(previous, current));
				output.push(current);
			} else if (previousInside) output.push(edge.cross(previous, current));
		}
	}
	return output;
};

const clipEllipse = (rect: SelectionRect, width: number, height: number): SelectionShape => {
	if (rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height) {
		return {kind: 'ellipse', bounds: rect};
	}
	const clipped = clipPolygon(ellipsePoints(rect), width, height);
	if (clipped.length < 3) return {kind: 'empty'};
	return {kind: 'polygon', points: clipped};
};

/**
 * Closes a marquee outline and combines it with the current selection.
 * A drag that encloses nothing deselects in New mode. The result is clipped to the canvas.
 * Moving a selection later does not use this, so the outline can leave and come back whole.
 */
export const applyMarquee = (
	current: SelectionShape | null,
	box: SelectionRect,
	outline: MarqueeOutline,
	mode: MarqueeMode,
	canvas: {width: number; height: number},
): 'deselect' | 'unchanged' | SelectionShape => {
	if (box.width <= 0 || box.height <= 0) return mode === 'replace' ? 'deselect' : 'unchanged';
	const next = outline === 'rectangle' ? shapeFromRects(clipRect(box, canvas.width, canvas.height) ? [clipRect(box, canvas.width, canvas.height)!] : []) : clipEllipse(box, canvas.width, canvas.height);
	if (mode === 'replace') return next;
	if (isEmptyShape(next)) return 'unchanged';
	if (!current) return mode === 'subtract' ? 'unchanged' : next;
	if (mode === 'subtract' && isEmptyShape(current)) return current;
	return combineShapes(current, next, mode);
};

/**
 * Closes a lasso outline and combines it with the current selection.
 * Fewer than three points, or a line with no area, deselects in New mode.
 * The outline is clipped to the canvas. A subtract that covers the whole
 * selection leaves an explicit empty selection.
 */
export const applyLasso = (
	current: SelectionShape | null,
	points: readonly SelectionPoint[],
	mode: MarqueeMode,
	canvas: {width: number; height: number},
): 'deselect' | 'unchanged' | SelectionShape => {
	const bounds = boundsOfPoints(points);
	if (points.length < 3 || !bounds || bounds.width <= 0 || bounds.height <= 0) {
		return mode === 'replace' ? 'deselect' : 'unchanged';
	}
	const clipped = clipPolygon(points.map((point) => ({...point})), canvas.width, canvas.height);
	const next: SelectionShape = clipped.length >= 3 ? {kind: 'polygon', points: clipped} : {kind: 'empty'};
	if (mode === 'replace') return next;
	if (isEmptyShape(next)) return 'unchanged';
	if (!current) return mode === 'subtract' ? 'unchanged' : next;
	if (mode === 'subtract' && isEmptyShape(current)) return current;
	const combined = combineShapes(current, next, mode);
	if (combined.kind === 'difference' && shapeCovered(combined.base, combined.cut)) return {kind: 'empty'};
	return combined;
};

const combineShapes = (base: SelectionShape, next: SelectionShape, mode: 'add' | 'subtract'): SelectionShape => {
	const existing = rectsOf(base);
	if (existing && next.kind === 'rect') {
		return shapeFromRects(mode === 'add' ? addRects(existing, next.bounds) : subtractRects(existing, next.bounds));
	}
	if (mode === 'add') return isEmptyShape(base) ? next : {kind: 'union', shapes: flattenUnion(base, next)};
	return {kind: 'difference', base, cut: next};
};

const flattenUnion = (base: SelectionShape, next: SelectionShape): SelectionShape[] => [
	...(base.kind === 'union' ? base.shapes : [base]),
	...(next.kind === 'union' ? next.shapes : [next]),
];

const signedArea = (points: readonly SelectionPoint[]) => {
	let sum = 0;
	for (let index = 0; index < points.length; index++) {
		const current = points[index]!;
		const next = points[(index + 1) % points.length]!;
		sum += current.x * next.y - next.x * current.y;
	}
	return sum / 2;
};

/**
 * Offsets a polygon by `delta` pixels (positive grows it). A collapse — inset past
 * the middle, or an edge that reverses — is `empty`. `null` means the outline could
 * not be rebuilt, so the caller keeps the original.
 */
const offsetPolygon = (points: readonly SelectionPoint[], delta: number): SelectionPoint[] | 'empty' | null => {
	if (!delta) return null;
	const cleaned = points.filter((point, index) => {
		const next = points[(index + 1) % points.length]!;
		return Math.hypot(next.x - point.x, next.y - point.y) >= 1e-6;
	});
	if (cleaned.length < 3) return 'empty';
	const area = signedArea(cleaned);
	if (Math.abs(area) < 1e-6) return 'empty';
	const outward = area > 0 ? 1 : -1;
	const edges = cleaned.map((start, index) => {
		const end = cleaned[(index + 1) % cleaned.length]!;
		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const length = Math.hypot(dx, dy);
		const nx = (dy / length) * outward;
		const ny = (-dx / length) * outward;
		return {px: start.x + nx * delta, py: start.y + ny * delta, dx, dy, nx, ny};
	});
	const result: SelectionPoint[] = [];
	for (let index = 0; index < edges.length; index++) {
		const previous = edges[(index + edges.length - 1) % edges.length]!;
		const current = edges[index]!;
		const vertex = cleaned[index]!;
		const cross = previous.dx * current.dy - previous.dy * current.dx;
		let hit: SelectionPoint | null = null;
		if (Math.abs(cross) > 1e-8) {
			const qx = current.px - previous.px;
			const qy = current.py - previous.py;
			const distance = (qx * current.dy - qy * current.dx) / cross;
			hit = {x: previous.px + distance * previous.dx, y: previous.py + distance * previous.dy};
		}
		const limit = Math.abs(delta) * 10;
		const tooFar = !hit || Math.hypot(hit.x - vertex.x, hit.y - vertex.y) > limit + 1e-6;
		if (tooFar || !hit) {
			result.push({x: vertex.x + previous.nx * delta, y: vertex.y + previous.ny * delta});
			result.push({x: vertex.x + current.nx * delta, y: vertex.y + current.ny * delta});
		} else result.push(hit);
	}
	if (result.length === edges.length) {
		const reversed = result.some((point, index) => {
			const next = result[(index + 1) % result.length]!;
			const edge = edges[index]!;
			return (next.x - point.x) * edge.dx + (next.y - point.y) * edge.dy <= 1e-6;
		});
		if (reversed) return 'empty';
	}
	if (Math.abs(signedArea(result)) < 1e-4 || Math.sign(signedArea(result)) !== Math.sign(area)) return 'empty';
	return result;
};

const inwardSamples = (shape: SelectionShape): SelectionPoint[] => {
	if (shape.kind === 'union') return shape.shapes.flatMap(inwardSamples);
	if (shape.kind === 'rects') return shape.rects.flatMap((bounds) => inwardSamples({kind: 'rect', bounds}));
	if (shape.kind === 'empty' || shape.kind === 'difference') return [];
	const raw =
		shape.kind === 'polygon'
			? shape.points
			: shape.kind === 'rect'
				? [
						{x: shape.bounds.x, y: shape.bounds.y},
						{x: shape.bounds.x + shape.bounds.width, y: shape.bounds.y},
						{x: shape.bounds.x + shape.bounds.width, y: shape.bounds.y + shape.bounds.height},
						{x: shape.bounds.x, y: shape.bounds.y + shape.bounds.height},
					]
				: Array.from({length: 8}, (_, index) => {
						const angle = (index / 8) * Math.PI * 2;
						return {
							x: shape.bounds.x + shape.bounds.width / 2 + (Math.cos(angle) * shape.bounds.width) / 2,
							y: shape.bounds.y + shape.bounds.height / 2 + (Math.sin(angle) * shape.bounds.height) / 2,
						};
					});
	if (raw.length < 3) return [];
	const center = raw.reduce((acc, point) => ({x: acc.x + point.x, y: acc.y + point.y}), {x: 0, y: 0});
	center.x /= raw.length;
	center.y /= raw.length;
	const pull = (point: SelectionPoint): SelectionPoint => ({
		x: center.x + (point.x - center.x) * 0.98,
		y: center.y + (point.y - center.y) * 0.98,
	});
	const mids = raw.map((point, index) => {
		const next = raw[(index + 1) % raw.length]!;
		return pull({x: (point.x + next.x) / 2, y: (point.y + next.y) / 2});
	});
	return [...raw.map(pull), ...mids, center];
};

/** True when every sampled point of `base` lies inside `cut`, so a subtract removes it all. */
const shapeCovered = (base: SelectionShape, cut: SelectionShape) => {
	const samples = inwardSamples(base);
	return samples.length > 0 && samples.every((point) => containsPoint(cut, point.x, point.y));
};

const outsetRect = (rect: SelectionRect, amount: number): SelectionRect => ({
	x: rect.x - amount,
	y: rect.y - amount,
	width: rect.width + amount * 2,
	height: rect.height + amount * 2,
});

const insetRect = (rect: SelectionRect, amount: number): SelectionRect | null => {
	const width = rect.width - amount * 2;
	const height = rect.height - amount * 2;
	if (width <= 0 || height <= 0) return null;
	return {x: rect.x + amount, y: rect.y + amount, width, height};
};

/** Grows the outline by `amount` pixels and clips the expansion to the canvas. */
export const expandShape = (shape: SelectionShape, amount: number, canvas: {width: number; height: number}): SelectionShape =>
	resizeShape(shape, amount, canvas);

/** Shrinks the outline by `amount` pixels, including away from the canvas edges. */
export const contractShape = (shape: SelectionShape, amount: number): SelectionShape =>
	resizeShape(shape, -amount, null);

const resizeShape = (shape: SelectionShape, delta: number, canvas: {width: number; height: number} | null): SelectionShape => {
	if (!delta || isEmptyShape(shape)) return shape;
	if (shape.kind === 'rect') return resizeRects([shape.bounds], delta, canvas);
	if (shape.kind === 'rects') return resizeRects(shape.rects, delta, canvas);
	if (shape.kind === 'ellipse') {
		const rect = delta > 0 ? outsetRect(shape.bounds, delta) : insetRect(shape.bounds, -delta);
		if (!rect) return {kind: 'empty'};
		return canvas ? clipEllipse(rect, canvas.width, canvas.height) : {kind: 'ellipse', bounds: rect};
	}
	if (shape.kind === 'polygon') {
		const offset = offsetPolygon(shape.points, delta);
		if (offset === 'empty') return {kind: 'empty'};
		if (!offset) return shape;
		if (!canvas || delta <= 0) return {kind: 'polygon', points: offset};
		const clipped = clipPolygon(offset, canvas.width, canvas.height);
		return clipped.length >= 3 ? {kind: 'polygon', points: clipped} : {kind: 'empty'};
	}
	if (shape.kind === 'union') {
		return shape.shapes.reduce<SelectionShape>(
			(result, entry) => {
				const resized = resizeShape(entry, delta, canvas);
				if (isEmptyShape(resized)) return result;
				if (isEmptyShape(result)) return resized;
				return {kind: 'union', shapes: flattenUnion(result, resized)};
			},
			{kind: 'empty'},
		);
	}
	if (shape.kind === 'difference') {
		// A larger selection grows the kept region and shrinks the hole.
		const base = resizeShape(shape.base, delta, canvas);
		const cut = resizeShape(shape.cut, -delta, delta < 0 ? canvas : null);
		if (isEmptyShape(base)) return {kind: 'empty'};
		if (isEmptyShape(cut)) return base;
		return {kind: 'difference', base, cut};
	}
	return shape;
};

const resizeRects = (rects: readonly SelectionRect[], delta: number, canvas: {width: number; height: number} | null): SelectionShape => {
	if (delta > 0) {
		const grown = rects.map((rect) => (canvas ? clipRect(outsetRect(rect, delta), canvas.width, canvas.height) : outsetRect(rect, delta))).filter((rect): rect is SelectionRect => Boolean(rect));
		return grown.reduce<SelectionShape>((result, rect) => combineShapes(result, {kind: 'rect', bounds: rect}, 'add'), {kind: 'empty'});
	}
	return shapeFromRects(rects.flatMap((rect) => {
		const inset = insetRect(rect, -delta);
		return inset ? [inset] : [];
	}));
};

/** Two soft edges together spread a little less than their sum. */
export const stackFeather = (current: number, amount: number) => Math.min(250, Math.sqrt(current * current + amount * amount));

export const selectionRecord = (
	shape: SelectionShape,
	options: {feather?: number; antialiased?: boolean; id?: string} = {},
): SelectionRecord => ({
	id: options.id ?? ACTIVE_SELECTION_ID,
	bounds: shapeBounds(shape) ?? ZERO,
	feather: options.feather ?? 0,
	inverted: false,
	geometry: {antialiased: options.antialiased ?? true, shape},
});

export const shapeFromRecord = (record: SelectionRecord | null | undefined): SelectionShape | null => {
	if (!record) return null;
	if (record.geometry?.shape) return record.geometry.shape;
	if (record.bounds.width > 0 && record.bounds.height > 0) return {kind: 'rect', bounds: record.bounds};
	return {kind: 'empty'};
};

export const sameSelection = (left: SelectionRecord | null | undefined, right: SelectionRecord | null | undefined) =>
	JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const selectAllShape = (width: number, height: number): SelectionShape => ({
	kind: 'rect',
	bounds: {x: 0, y: 0, width, height},
});

type Span = {fixed: number; a: number; b: number; dir: number};

const quantize = (value: number) => Math.round(value * 1000) / 1000;

/** Boundary loops of a set of rectangles, with shared edges cancelled. */
export const rectOutlineLoops = (rects: readonly SelectionRect[]): SelectionPoint[][] => {
	const horizontal: Span[] = [];
	const vertical: Span[] = [];
	for (const rect of rects) {
		if (rectArea(rect) <= 0) continue;
		const right = rect.x + rect.width;
		const bottom = rect.y + rect.height;
		horizontal.push({fixed: rect.y, a: rect.x, b: right, dir: 1}, {fixed: bottom, a: rect.x, b: right, dir: -1});
		vertical.push({fixed: rect.x, a: rect.y, b: bottom, dir: -1}, {fixed: right, a: rect.y, b: bottom, dir: 1});
	}
	const segments: Array<{x1: number; y1: number; x2: number; y2: number}> = [];
	for (const span of boundarySpans(horizontal)) {
		const y = quantize(span.fixed);
		const start = quantize(span.dir > 0 ? span.a : span.b);
		const end = quantize(span.dir > 0 ? span.b : span.a);
		segments.push({x1: start, y1: y, x2: end, y2: y});
	}
	for (const span of boundarySpans(vertical)) {
		const x = quantize(span.fixed);
		const start = quantize(span.dir > 0 ? span.a : span.b);
		const end = quantize(span.dir > 0 ? span.b : span.a);
		segments.push({x1: x, y1: start, x2: x, y2: end});
	}
	return chainLoops(segments);
};

const boundarySpans = (spans: readonly Span[]): Span[] => {
	const groups = new Map<number, Span[]>();
	for (const span of spans) {
		const fixed = quantize(span.fixed);
		const group = groups.get(fixed) ?? [];
		group.push({...span, fixed, a: quantize(span.a), b: quantize(span.b)});
		groups.set(fixed, group);
	}
	const result: Span[] = [];
	for (const [fixed, group] of groups) {
		const coords = [...new Set(group.flatMap((span) => [span.a, span.b]))].sort((left, right) => left - right);
		for (let index = 0; index < coords.length - 1; index++) {
			const a = coords[index]!;
			const b = coords[index + 1]!;
			if (b - a <= 0) continue;
			const mid = (a + b) / 2;
			let wind = 0;
			for (const span of group) {
				const lo = Math.min(span.a, span.b);
				const hi = Math.max(span.a, span.b);
				if (mid > lo && mid < hi) wind += span.dir;
			}
			if (wind !== 0) result.push({fixed, a, b, dir: Math.sign(wind)});
		}
	}
	return result;
};

const chainLoops = (segments: Array<{x1: number; y1: number; x2: number; y2: number}>): SelectionPoint[][] => {
	const key = (x: number, y: number) => `${x},${y}`;
	const outgoing = new Map<string, Array<{x: number; y: number}>>();
	for (const segment of segments) {
		if (segment.x1 === segment.x2 && segment.y1 === segment.y2) continue;
		const list = outgoing.get(key(segment.x1, segment.y1)) ?? [];
		list.push({x: segment.x2, y: segment.y2});
		outgoing.set(key(segment.x1, segment.y1), list);
	}
	const loops: SelectionPoint[][] = [];
	for (const [startKey, remaining] of outgoing) {
		while (remaining.length) {
			const [x, y] = startKey.split(',').map(Number);
			const loop: SelectionPoint[] = [{x: x!, y: y!}];
			let current = startKey;
			let guard = segments.length + 2;
			while (guard--) {
				const next = outgoing.get(current)?.pop();
				if (!next) break;
				loop.push(next);
				current = key(next.x, next.y);
				if (current === startKey) break;
			}
			if (loop.length > 2) loops.push(loop);
		}
	}
	return loops;
};

const loopsToPath = (loops: SelectionPoint[][]) =>
	loops
		.map((loop) => {
			const [first, ...rest] = loop;
			if (!first) return '';
			return `M ${first.x} ${first.y} ${rest.map((point) => `L ${point.x} ${point.y}`).join(' ')} Z`;
		})
		.filter(Boolean)
		.join(' ');

export const selectionFigures = (record: SelectionRecord | null | undefined): SelectionFigure[] => {
	const shape = shapeFromRecord(record);
	if (!shape || isEmptyShape(shape)) return [];
	return figuresFor(shape);
};

const figuresFor = (shape: SelectionShape): SelectionFigure[] => {
	if (shape.kind === 'empty') return [];
	if (shape.kind === 'ellipse') return [{kind: 'ellipse', bounds: shape.bounds}];
	if (shape.kind === 'rect' || shape.kind === 'rects') {
		const path = loopsToPath(rectOutlineLoops(shape.kind === 'rect' ? [shape.bounds] : shape.rects));
		return path ? [{kind: 'path', d: path}] : [];
	}
	if (shape.kind === 'polygon') {
		const path = loopsToPath([shape.points]);
		return path ? [{kind: 'path', d: path}] : [];
	}
	if (shape.kind === 'union') return shape.shapes.flatMap(figuresFor);
	return [...figuresFor(shape.base), ...figuresFor(shape.cut)];
};

export const marqueeSnapTargets = (document: DocumentState) => {
	const xs = [0, document.width];
	const ys = [0, document.height];
	for (const guide of document.guides) {
		if (guide.orientation === 'vertical') xs.push(guide.position);
		else ys.push(guide.position);
	}
	for (const layer of Object.values(document.layers)) {
		if (!layer.visible) continue;
		const bounds = getLayerBounds(document, layer.id);
		if (!bounds) continue;
		xs.push(Math.round(bounds.left), Math.round(bounds.right));
		ys.push(Math.round(bounds.top), Math.round(bounds.bottom));
	}
	return {xs, ys};
};

const nearest = (value: number, targets: readonly number[], tolerance: number) => {
	let best: number | null = null;
	for (const target of targets) {
		const distance = Math.abs(target - value);
		if (distance <= tolerance && (best === null || distance < Math.abs(best - value))) best = target;
	}
	return best;
};

/** Moves one corner onto the nearest snap target on each axis, unless snapping is disabled. */
export const snapMarqueePoint = (
	point: SelectionPoint,
	targets: {xs: readonly number[]; ys: readonly number[]},
	tolerance: number,
	enabled: boolean,
): {point: SelectionPoint; guides: SnapGuide[]} => {
	if (!enabled) return {point, guides: []};
	const x = nearest(point.x, targets.xs, tolerance);
	const y = nearest(point.y, targets.ys, tolerance);
	return {
		point: {x: x ?? point.x, y: y ?? point.y},
		guides: [
			...(x === null ? [] : [{orientation: 'vertical' as const, position: x}]),
			...(y === null ? [] : [{orientation: 'horizontal' as const, position: y}]),
		],
	};
};

/** Nudges a moved selection so an edge or its middle meets a nearby target. A locked axis does not snap. */
export const snapSelectionOffset = (
	bounds: SelectionRect,
	offset: SelectionPoint,
	targets: {xs: readonly number[]; ys: readonly number[]},
	tolerance: number,
	horizontal: boolean,
	vertical: boolean,
): {offset: SelectionPoint; guides: SnapGuide[]} => {
	const rounded = {x: roundWhole(offset.x), y: roundWhole(offset.y)};
	const shift = (guides: number[], lines: readonly number[]) => {
		let best: {move: number; target: number} | null = null;
		for (const guide of guides) {
			for (const target of lines) {
				const move = target - guide;
				if (Math.abs(move) > tolerance) continue;
				if (!best || Math.abs(move) < Math.abs(best.move)) best = {move, target};
			}
		}
		return best;
	};
	const boxX = [bounds.x + rounded.x, bounds.x + bounds.width / 2 + rounded.x, bounds.x + bounds.width + rounded.x];
	const boxY = [bounds.y + rounded.y, bounds.y + bounds.height / 2 + rounded.y, bounds.y + bounds.height + rounded.y];
	const x = horizontal ? shift(boxX, targets.xs) : null;
	const y = vertical ? shift(boxY, targets.ys) : null;
	return {
		offset: {x: rounded.x + (x?.move ?? 0), y: rounded.y + (y?.move ?? 0)},
		guides: [
			...(x ? [{orientation: 'vertical' as const, position: x.target}] : []),
			...(y ? [{orientation: 'horizontal' as const, position: y.target}] : []),
		],
	};
};

/** How far, in viewport pixels per frame, the view pans toward a pointer near or past the edge. */
export const marqueeAutoscrollDelta = (point: SelectionPoint, viewport: {width: number; height: number}) => {
	const margin = 12;
	const speed = (past: number) => (past <= 0 ? 0 : Math.min(40, 2 + past * 0.4));
	const left = speed(margin - point.x);
	const right = speed(point.x - (viewport.width - margin));
	const top = speed(margin - point.y);
	const bottom = speed(point.y - (viewport.height - margin));
	return {x: left - right, y: top - bottom};
};
