import {
	ACTIVE_SELECTION_ID,
	MARQUEE_SNAP_DISTANCE,
	applyLasso,
	containsPoint,
	isEmptyShape,
	marqueeAutoscrollDelta,
	marqueeSnapTargets,
	roundWhole,
	sameSelection,
	selectionRecord,
	shapeBounds,
	shapeFromRecord,
	snapSelectionOffset,
	translateShape,
	type MarqueeMode,
} from '../../document/selection-geometry';
import type {SelectionRecord, SelectionShape} from '../../document/types';
import {documentToViewport, viewportToDocument} from '../coordinates';
import {lassoDrawCursor, lassoMoveCursor} from '../lasso/lasso-cursors';
import {
	getLassoToolSettings,
	toggleLassoKind,
	updateLassoToolSettings,
	type LassoKind,
	type LassoToolSettings,
} from '../lasso/lasso-settings';
import type {ToolCancelReason, ToolKeyEvent, ToolModifiers, ToolPointerEvent} from '../types';
import {BaseToolSession} from './base';

type SelectionPoint = {x: number; y: number};

type DrawGesture = {
	kind: 'draw';
	points: SelectionPoint[];
	cursor: SelectionPoint | null;
	mode: MarqueeMode;
	outline: LassoKind;
	/** Freehand extends while the button is down. Polygonal waits for the next click. */
	drawing: boolean;
};

type MoveGesture = {
	kind: 'move';
	origin: SelectionShape;
	feather: number;
	antialiased: boolean;
	start: SelectionPoint;
	dragged: boolean;
};

type IgnoredGesture = {kind: 'ignored'};

type Gesture = DrawGesture | MoveGesture | IgnoredGesture;

/** View pixels: a polygonal click this close to the first corner closes the outline. */
const CLOSE_DISTANCE = 8;
/** Document pixels: outline points closer than this are skipped. */
const POINT_SPACING = 0.25;

const selectionMode = (settings: LassoToolSettings, shift: boolean, alt: boolean): MarqueeMode =>
	alt ? 'subtract' : shift ? 'add' : settings.mode;

const finite = (point: SelectionPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

/**
 * Freehand and polygonal lasso, following Compositor's Selection.swift and the lasso
 * branches of EditorCanvas. L keeps whichever mode was last set. Tab switches it.
 * Shift adds, Option subtracts, and in New mode a drag inside the selection moves
 * the outline. Polygonal closes on a click near the start, a double-click, or Enter.
 */
export class LassoToolSession extends BaseToolSession {
	private gesture: Gesture | null = null;
	private lastPoint: ToolPointerEvent | null = null;
	private lastModifiers: ToolModifiers = {shift: false, alt: false, meta: false, control: false, space: false};
	private autoscroll: ReturnType<typeof setInterval> | null = null;

	constructor(
		context: ConstructorParameters<typeof BaseToolSession>[1],
		toolId: 'lasso' | 'polygon-lasso' = 'lasso',
	) {
		super(toolId, context);
		this.paintHover(null);
	}

	sync() {
		const settings = getLassoToolSettings();
		if (this.gesture?.kind === 'draw' && settings.kind !== this.gesture.outline) {
			this.cancelDraft();
			this.paintHover(this.lastPoint);
			return;
		}
		if (!this.gesture) this.paintHover(this.lastPoint);
	}

	pointerDown(event: ToolPointerEvent) {
		super.pointerDown(event);
		this.lastPoint = event;
		this.lastModifiers = event.modifiers;
		this.publishHeld(event.modifiers);
		if (!finite(event.documentPoint)) return;
		const drawing = this.gesture;
		if (drawing?.kind === 'draw' && drawing.outline === 'polygonal') {
			const close =
				(event.clickCount ?? 1) >= 2 || (drawing.points.length >= 3 && this.nearStart(event, drawing.points));
			if (close) this.finish();
			else {
				this.extend(drawing, event.documentPoint);
				drawing.cursor = {...event.documentPoint};
				this.paintDraft();
			}
			return;
		}
		const settings = getLassoToolSettings();
		const mode = selectionMode(settings, event.modifiers.shift, event.modifiers.alt);
		const shape = shapeFromRecord(this.context.document.selections[ACTIVE_SELECTION_ID]);
		const inside = Boolean(shape && !isEmptyShape(shape) && containsPoint(shape, event.documentPoint.x, event.documentPoint.y));
		// Cmd-drag inside the selection is the temporary move of its pixels. Without a raster lift
		// there is nothing to move, and the press must not start a new outline.
		if (event.modifiers.meta && inside) {
			this.gesture = {kind: 'ignored'};
			this.overlay = {canvasCursor: event.modifiers.alt ? 'copy' : 'not-allowed'};
			return;
		}
		if (mode === 'replace' && inside && shape) {
			const record = this.context.document.selections[ACTIVE_SELECTION_ID]!;
			this.gesture = {
				kind: 'move',
				origin: shape,
				feather: record.feather,
				antialiased: record.geometry?.antialiased ?? true,
				start: {...event.documentPoint},
				dragged: false,
			};
			this.overlay = {canvasCursor: lassoMoveCursor, selectionPreview: record};
			return;
		}
		this.gesture = {
			kind: 'draw',
			points: [{...event.documentPoint}],
			cursor: null,
			mode,
			outline: settings.kind,
			drawing: settings.kind === 'freehand',
		};
		updateLassoToolSettings({draftMode: mode, draftActive: true});
		this.paintDraft();
	}

	pointerMove(event: ToolPointerEvent) {
		this.lastPoint = event;
		this.lastModifiers = event.modifiers;
		this.publishHeld(event.modifiers);
		if (!finite(event.documentPoint)) return;
		const gesture = this.gesture;
		if (!gesture) {
			this.paintHover(event);
			return;
		}
		if (gesture.kind === 'ignored') return;
		if (gesture.kind === 'move') {
			if (event.documentPoint.x !== gesture.start.x || event.documentPoint.y !== gesture.start.y) gesture.dragged = true;
			this.redrawMove(event.documentPoint, event.modifiers);
			this.updateAutoscroll(event);
			return;
		}
		if (gesture.drawing) {
			this.extend(gesture, event.documentPoint);
			this.paintDraft();
			return;
		}
		gesture.cursor = {...event.documentPoint};
		this.paintDraft();
	}

	pointerUp(event: ToolPointerEvent) {
		this.stopAutoscroll();
		this.lastPoint = event;
		this.lastModifiers = event.modifiers;
		const gesture = this.gesture;
		if (!gesture) return;
		if (gesture.kind === 'ignored') {
			this.gesture = null;
			this._status = 'committed';
			this.paintHover(event);
			return;
		}
		if (gesture.kind === 'move') {
			if (!gesture.dragged) this.deselect();
			else {
				this.redrawMove(event.documentPoint, event.modifiers);
				const preview = this.overlay?.selectionPreview ?? null;
				const origin = selectionRecord(gesture.origin, {feather: gesture.feather, antialiased: gesture.antialiased});
				if (!preview || sameSelection(origin, preview)) this.deselect();
				else this.commitRecord(preview);
			}
			this.gesture = null;
			this._status = 'committed';
			this.paintHover(event);
			return;
		}
		if (gesture.outline === 'polygonal') {
			if (finite(event.documentPoint)) gesture.cursor = {...event.documentPoint};
			this.paintDraft();
			return;
		}
		this.finish();
	}

	pointerCancel(reason: ToolCancelReason) {
		// Releasing pointer capture between polygonal clicks is a normal mouse-up, not a cancel.
		if (
			(reason === 'lostpointercapture' || reason === 'pointercancel') &&
			this.gesture?.kind === 'draw' &&
			this.gesture.outline === 'polygonal'
		) {
			return;
		}
		this.cancelDraft();
		super.pointerCancel(reason);
		if (this._status !== 'disposed') this.paintHover(this.lastPoint);
	}

	keyDown(event: ToolKeyEvent) {
		if (event.key === 'Escape') {
			this.pointerCancel('escape');
			return true;
		}
		if (event.key === 'Tab' && !event.modifiers.meta && !event.modifiers.control && !event.modifiers.alt && !event.modifiers.shift) {
			this.cancelDraft();
			toggleLassoKind();
			this._status = 'idle';
			this.paintHover(this.lastPoint);
			return true;
		}
		if ((event.key === 'Enter' || event.key === 'NumpadEnter') && this.gesture?.kind === 'draw' && !event.modifiers.meta && !event.modifiers.control && !event.modifiers.alt) {
			this.finish();
			return true;
		}
		if (event.key === 'Shift' || event.key === 'Alt' || event.key === 'Control' || event.key === 'Meta') {
			this.lastModifiers = event.modifiers;
			this.publishHeld(event.modifiers);
			if (this.gesture?.kind === 'move' && this.lastPoint) this.redrawMove(this.lastPoint.documentPoint, event.modifiers);
			else if (!this.gesture) this.paintHover(this.lastPoint);
			return true;
		}
		if ((event.key === 'Backspace' || event.key === 'Delete') && !event.modifiers.meta && !event.modifiers.control && !event.modifiers.alt && !event.modifiers.shift) {
			if (this.gesture?.kind === 'draw') {
				this.removeLast();
				return true;
			}
			return Boolean(this.context.document.selections[ACTIVE_SELECTION_ID]);
		}
		if (this.gesture || event.modifiers.meta || event.modifiers.control || event.modifiers.alt) return false;
		const step = event.modifiers.shift ? 10 : 1;
		const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
		const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
		if (!dx && !dy) return false;
		const record = this.context.document.selections[ACTIVE_SELECTION_ID];
		const shape = shapeFromRecord(record);
		if (!record || !shape || isEmptyShape(shape)) return false;
		this.commitShape(translateShape(shape, dx, dy), record.feather, record.geometry?.antialiased ?? true);
		return true;
	}

	keyUp(event: ToolKeyEvent) {
		if (event.key !== 'Shift' && event.key !== 'Alt' && event.key !== 'Control' && event.key !== 'Meta') return false;
		this.lastModifiers = event.modifiers;
		this.publishHeld(event.modifiers);
		if (this.gesture?.kind === 'move' && this.lastPoint) this.redrawMove(this.lastPoint.documentPoint, event.modifiers);
		else if (!this.gesture) this.paintHover(this.lastPoint);
		return true;
	}

	dispose() {
		this.stopAutoscroll();
		this.gesture = null;
		updateLassoToolSettings({draftMode: null, draftActive: false, held: null});
		super.dispose();
	}

	private cancelDraft() {
		this.stopAutoscroll();
		this.gesture = null;
		updateLassoToolSettings({draftMode: null, draftActive: false});
	}

	private publishHeld(modifiers: ToolModifiers) {
		const held: MarqueeMode | null = modifiers.alt ? 'subtract' : modifiers.shift ? 'add' : null;
		updateLassoToolSettings({held});
	}

	private extend(gesture: DrawGesture, point: SelectionPoint) {
		if (!finite(point)) return;
		const last = gesture.points.at(-1);
		if (last && Math.hypot(point.x - last.x, point.y - last.y) < POINT_SPACING) return;
		gesture.points.push({x: point.x, y: point.y});
	}

	private removeLast() {
		const gesture = this.gesture;
		if (gesture?.kind !== 'draw') return;
		gesture.points.pop();
		if (gesture.points.length) {
			this.paintDraft();
			return;
		}
		this.cancelDraft();
		this._status = 'idle';
		this.paintHover(this.lastPoint);
	}

	private nearStart(event: ToolPointerEvent, points: readonly SelectionPoint[]) {
		const first = points[0];
		if (!first) return false;
		const snapshot = this.context.getViewport?.() ?? this.context.viewport;
		const view = documentToViewport(first, snapshot);
		return Math.hypot(view.x - event.viewportPoint.x, view.y - event.viewportPoint.y) <= CLOSE_DISTANCE;
	}

	private finish() {
		const gesture = this.gesture;
		if (gesture?.kind !== 'draw') return;
		const points = gesture.points.map((point) => ({...point}));
		const mode = gesture.mode;
		this.gesture = null;
		this.stopAutoscroll();
		updateLassoToolSettings({draftMode: null, draftActive: false});
		const result = applyLasso(
			shapeFromRecord(this.context.document.selections[ACTIVE_SELECTION_ID]),
			points,
			mode,
			this.context.document,
		);
		if (result === 'deselect') this.deselect();
		else if (result !== 'unchanged') this.commitShape(result, 0, getLassoToolSettings().antialiased);
		this._status = 'committed';
		this.paintHover(this.lastPoint);
	}

	private paintDraft() {
		const gesture = this.gesture;
		if (gesture?.kind !== 'draw') return;
		this.overlay = {
			selectionDraft: {
				kind: 'lasso',
				points: gesture.points.map((point) => ({...point})),
				cursor: gesture.outline === 'polygonal' ? gesture.cursor : null,
				polygonal: gesture.outline === 'polygonal',
			},
			canvasCursor: lassoDrawCursor(gesture.outline, gesture.mode),
			snapGuides: [],
		};
	}

	private redrawMove(point: SelectionPoint, modifiers: ToolModifiers) {
		const gesture = this.gesture;
		if (gesture?.kind !== 'move') return;
		let dx = point.x - gesture.start.x;
		let dy = point.y - gesture.start.y;
		let horizontal = true;
		let vertical = true;
		if (modifiers.shift) {
			if (Math.abs(dx) >= Math.abs(dy)) {
				dy = 0;
				vertical = false;
			} else {
				dx = 0;
				horizontal = false;
			}
		}
		const bounds = shapeBounds(gesture.origin) ?? {x: 0, y: 0, width: 0, height: 0};
		const snapped = modifiers.control
			? {offset: {x: roundWhole(dx), y: roundWhole(dy)}, guides: []}
			: snapSelectionOffset(bounds, {x: dx, y: dy}, this.targets(), this.tolerance(), horizontal, vertical);
		// moveSelection rounds after snapping, so an edge stays on a whole pixel.
		const moved = translateShape(gesture.origin, roundWhole(snapped.offset.x), roundWhole(snapped.offset.y));
		this.overlay = {
			selectionPreview: selectionRecord(moved, {feather: gesture.feather, antialiased: gesture.antialiased}),
			snapGuides: snapped.guides,
			canvasCursor: lassoMoveCursor,
		};
	}

	private paintHover(event: ToolPointerEvent | null) {
		if (this.gesture) return;
		const shape = shapeFromRecord(this.context.document.selections[ACTIVE_SELECTION_ID]);
		const inside = Boolean(event && shape && !isEmptyShape(shape) && containsPoint(shape, event.documentPoint.x, event.documentPoint.y));
		const mode = selectionMode(
			getLassoToolSettings(),
			event?.modifiers.shift ?? this.lastModifiers.shift,
			event?.modifiers.alt ?? this.lastModifiers.alt,
		);
		const meta = event?.modifiers.meta ?? this.lastModifiers.meta;
		const alt = event?.modifiers.alt ?? this.lastModifiers.alt;
		this.overlay = {
			canvasCursor:
				meta && inside ? (alt ? 'copy' : 'not-allowed') : mode === 'replace' && inside ? lassoMoveCursor : lassoDrawCursor(getLassoToolSettings().kind, mode),
			snapGuides: [],
		};
	}

	private commitShape(shape: SelectionShape, feather: number, antialiased: boolean) {
		this.commitRecord(selectionRecord(shape, {feather, antialiased}));
	}

	private commitRecord(next: SelectionRecord) {
		const current = this.context.document.selections[ACTIVE_SELECTION_ID] ?? null;
		if (sameSelection(current, next)) return;
		this.writeSelection(next);
	}

	private deselect() {
		if (!this.context.document.selections[ACTIVE_SELECTION_ID]) return;
		this.writeSelection(null);
	}

	private writeSelection(next: SelectionRecord | null) {
		const before = this.context.document;
		this.context.commitSelection(next);
		if (this.context.document !== before) return;
		const selections = {...before.selections};
		if (next) selections[next.id] = next;
		else delete selections[ACTIVE_SELECTION_ID];
		this.context.document = {...before, selections};
	}

	private targets() {
		return marqueeSnapTargets(this.context.document);
	}

	private tolerance() {
		const snapshot = this.context.getViewport?.() ?? this.context.viewport;
		const zoom = snapshot.pointsPerPixel || snapshot.transform.zoom || 1;
		return MARQUEE_SNAP_DISTANCE / Math.max(zoom, 0.0001);
	}

	private updateAutoscroll(event: ToolPointerEvent) {
		if (!this.context.getViewport || this.gesture?.kind !== 'move') {
			this.stopAutoscroll();
			return;
		}
		const snapshot = this.context.getViewport();
		const delta = marqueeAutoscrollDelta(event.viewportPoint, snapshot.viewport);
		if (!delta.x && !delta.y) {
			this.stopAutoscroll();
			return;
		}
		if (this.autoscroll) return;
		this.autoscroll = setInterval(() => this.stepAutoscroll(), 1000 / 60);
	}

	private stepAutoscroll() {
		const event = this.lastPoint;
		const read = this.context.getViewport;
		if (!event || !read || this.gesture?.kind !== 'move') {
			this.stopAutoscroll();
			return;
		}
		const delta = marqueeAutoscrollDelta(event.viewportPoint, read().viewport);
		if (!delta.x && !delta.y) {
			this.stopAutoscroll();
			return;
		}
		this.context.setViewportPan(delta);
		const documentPoint = viewportToDocument(event.viewportPoint, read());
		this.gesture.dragged = true;
		this.redrawMove(documentPoint, this.lastModifiers);
		this.context.notifyOverlay?.();
	}

	private stopAutoscroll() {
		if (!this.autoscroll) return;
		clearInterval(this.autoscroll);
		this.autoscroll = null;
	}
}
