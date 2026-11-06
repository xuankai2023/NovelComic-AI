import type {DocumentState} from '../../document/types';
import {dragBox, roundWhole} from '../../document/selection-geometry';
import {SHAPE_KIND_NAMES, type ShapeKind} from './shape-settings';

export type ShapePoint = {x: number; y: number};
export type ShapeRect = {x: number; y: number; width: number; height: number};

/** A shape being dragged out, in document pixels. Same fields as Compositor's `ShapeDraft`. */
export type ShapeDraft = {
	kind: ShapeKind;
	anchor: ShapePoint;
	rect: ShapeRect;
	/** Where a line is being dragged to. Other shapes leave this empty. */
	end: ShapePoint | null;
	/** Document pixels, fixed when the drag starts. Ellipses and lines keep 0. */
	cornerRadius: number;
};

/** Stand-in id while the drag is only a preview. Never written into the document. */
export const SHAPE_PREVIEW_ID = 'shape-draft';

/** One shape layer's pixel budget. Compositor's `DocumentLimits.maxSurfacePixels`. */
export const MAX_SHAPE_PIXELS = 200_000_000;
export const MAX_SHAPE_MEGAPIXELS = MAX_SHAPE_PIXELS / 1_000_000;

const finitePoint = (point: ShapePoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

export const shapeTooLargeMessage = () =>
	`That shape is too large. A shape can cover up to ${MAX_SHAPE_MEGAPIXELS} megapixels.`;

/** Rounds the press onto a whole pixel. Ellipses and lines take no corner radius. */
export const beginShapeDraft = (point: ShapePoint, kind: ShapeKind, cornerRadius: number): ShapeDraft | null => {
	if (!finitePoint(point)) return null;
	const anchor = {x: roundWhole(point.x), y: roundWhole(point.y)};
	return {
		kind,
		anchor,
		rect: {x: anchor.x, y: anchor.y, width: 0, height: 0},
		end: null,
		cornerRadius: kind === 'rectangle' ? cornerRadius : 0,
	};
};

/**
 * Shift makes a square or circle. On a line it snaps the angle to eighths of a
 * turn. Option grows a rectangle or ellipse from its center. A line's ends stay
 * the two dragged points; Option only changes that line's preview box.
 */
export const dragShapeDraft = (draft: ShapeDraft, point: ShapePoint, square: boolean, fromCenter: boolean): ShapeDraft => {
	if (!finitePoint(point)) return draft;
	if (draft.kind === 'line' && square) {
		const dx = point.x - draft.anchor.x;
		const dy = point.y - draft.anchor.y;
		const angle = roundWhole(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
		const length = Math.hypot(dx, dy);
		const snapped = {
			x: draft.anchor.x + Math.cos(angle) * length,
			y: draft.anchor.y + Math.sin(angle) * length,
		};
		return {...draft, end: snapped, rect: dragBox(draft.anchor, snapped, false, fromCenter)};
	}
	return {
		...draft,
		end: draft.kind === 'line' ? point : draft.end,
		rect: dragBox(draft.anchor, point, square, fromCenter),
	};
};

/** A flat or upright line has a box with no height or width, which is not empty here. */
export const shapeDraftVisible = (draft: ShapeDraft) =>
	draft.kind === 'line' ? draft.rect.width > 0 || draft.rect.height > 0 : draft.rect.width > 0 && draft.rect.height > 0;

export type CommittedShape = {
	status: 'ok' | 'too-large';
	rect: ShapeRect;
	cornerRadius: number;
	lineWidth: number;
	/** Fractions of the layer box. Lines only. */
	start: ShapePoint | null;
	end: ShapePoint | null;
};

const tooLarge = (rect: ShapeRect) => {
	const width = Math.trunc(rect.width);
	const height = Math.trunc(rect.height);
	if (width < 1 || height < 1) return false;
	if (width > Number.MAX_SAFE_INTEGER / height) return true;
	return width * height > MAX_SHAPE_PIXELS;
};

/**
 * The layer box for a finished drag. A click with no size makes nothing.
 * A line keeps the two points it was dragged between; the box has room for the
 * stroke and its round ends.
 */
export const commitShapeBounds = (draft: ShapeDraft, lineWidth: number): CommittedShape | 'empty' => {
	let rect = {...draft.rect};
	let start: ShapePoint | null = null;
	let end: ShapePoint | null = null;
	if (draft.kind === 'line') {
		const from = draft.anchor;
		const to = draft.end ?? draft.anchor;
		const x = Math.min(from.x, to.x);
		const y = Math.min(from.y, to.y);
		const width = Math.abs(to.x - from.x);
		const height = Math.abs(to.y - from.y);
		rect = {x: x - lineWidth / 2, y: y - lineWidth / 2, width: width + lineWidth, height: height + lineWidth};
		const unit = (point: ShapePoint): ShapePoint => ({
			x: rect.width > 0 ? (point.x - rect.x) / rect.width : 0.5,
			y: rect.height > 0 ? (point.y - rect.y) / rect.height : 0.5,
		});
		start = unit(from);
		end = unit(to);
	}
	if (!(rect.width >= 1 && rect.height >= 1)) return 'empty';
	return {status: tooLarge(rect) ? 'too-large' : 'ok', rect, cornerRadius: draft.cornerRadius, lineWidth, start, end};
};

/** "Rectangle 1", "Ellipse 2", … skipping names already in the document. */
export const nextShapeName = (kind: ShapeKind, names: Iterable<string>) => {
	const taken = new Set(names);
	const label = SHAPE_KIND_NAMES[kind];
	let number = 1;
	while (taken.has(`${label} ${number}`)) number += 1;
	return `${label} ${number}`;
};

/** Inside the active folder, or beside the active layer. A selected folder receives the shape. */
export const shapeParentId = (document: DocumentState, activeLayerId: string | null) => {
	const active = activeLayerId ? document.layers[activeLayerId] : undefined;
	if (!active || active.id === SHAPE_PREVIEW_ID) return null;
	return active.kind === 'group' ? active.id : active.parentId;
};

/**
 * Just above the active layer. A selected folder gets the shape at the bottom of
 * its contents, matching `addPixelLayer` inserting at the folder's index + 1.
 */
export const shapeInsertionOrder = (document: DocumentState, activeLayerId: string | null, parentId: string | null) => {
	const active = activeLayerId ? document.layers[activeLayerId] : undefined;
	const siblings = Object.values(document.layers).filter((layer) => layer.parentId === parentId && layer.id !== SHAPE_PREVIEW_ID);
	if (active && active.kind === 'group' && active.id === parentId) {
		if (!siblings.length) return 0;
		return Math.min(...siblings.map((layer) => layer.order)) - 1;
	}
	if (active && active.id !== SHAPE_PREVIEW_ID && active.parentId === parentId) {
		const above = siblings
			.filter((layer) => layer.order > active.order)
			.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
		const next = above[0];
		return next ? (active.order + next.order) / 2 : active.order + 1;
	}
	return siblings.reduce((max, layer) => Math.max(max, layer.order), -1) + 1;
};
