import {
	ACTIVE_SELECTION_ID,
	MARQUEE_SNAP_DISTANCE,
	applyMarquee,
	containsPoint,
	dragBox,
	isEmptyShape,
	marqueeAutoscrollDelta,
	marqueeSnapTargets,
	roundWhole,
	sameSelection,
	selectionRecord,
	shapeBounds,
	shapeFromRecord,
	snapMarqueePoint,
	snapSelectionOffset,
	translateShape,
	type MarqueeMode,
	type MarqueeOutline,
	type SelectionPoint,
} from '../../document/selection-geometry';
import type {SelectionRecord, SelectionShape} from '../../document/types';
import {viewportToDocument} from '../coordinates';
import {
	getMarqueeToolSettings,
	updateMarqueeToolSettings,
	type MarqueeToolSettings,
} from '../marquee/marquee-settings';
import type {ToolCancelReason, ToolKeyEvent, ToolModifiers, ToolPointerEvent} from '../types';
import {BaseToolSession} from './base';

type DrawGesture = {
	kind: 'draw';
	anchor: SelectionPoint;
	rawPoint: SelectionPoint;
	mode: MarqueeMode;
	constrainArmed: boolean;
	outline: MarqueeOutline;
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

const selectionMode = (settings: MarqueeToolSettings, shift: boolean, alt: boolean): MarqueeMode =>
	alt ? 'subtract' : shift ? 'add' : settings.mode;

/**
 * Rectangular and elliptical marquee, following Compositor's Selection.swift and the
 * marquee branches of EditorCanvas. Shift held at the press adds; a Shift pressed again
 * during the drag squares or circles. Option subtracts and never draws from the center.
 */
export class MarqueeToolSession extends BaseToolSession {
	private gesture: Gesture | null = null;
	private lastPoint: ToolPointerEvent | null = null;
	private lastModifiers: ToolModifiers = {shift: false, alt: false, meta: false, control: false, space: false};
	private autoscroll: ReturnType<typeof setInterval> | null = null;

	constructor(context: ConstructorParameters<typeof BaseToolSession>[1], toolId: 'marquee-rectangle' | 'marquee-ellipse' = 'marquee-rectangle') {
		super(toolId, context);
		this.paintHover(null);
	}

	sync() {
		const settings = getMarqueeToolSettings();
		if (this.gesture?.kind === 'draw' && settings.kind !== this.gesture.outline) {
			this.stopAutoscroll();
			this.gesture = null;
			this.overlay = null;
		}
		if (!this.gesture) this.paintHover(this.lastPoint);
	}

	pointerDown(event: ToolPointerEvent) {
		super.pointerDown(event);
		this.lastPoint = event;
		this.lastModifiers = event.modifiers;
		this.publishHeld(event.modifiers);
		const settings = getMarqueeToolSettings();
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
				start: event.documentPoint,
				dragged: false,
			};
			this.overlay = {canvasCursor: 'default', selectionPreview: record};
			return;
		}
		const snapped = this.snap(event.documentPoint, event.modifiers);
		const anchor = {x: roundWhole(snapped.point.x), y: roundWhole(snapped.point.y)};
		this.gesture = {
			kind: 'draw',
			anchor,
			rawPoint: event.documentPoint,
			mode,
			constrainArmed: !event.modifiers.shift,
			outline: settings.kind,
		};
		updateMarqueeToolSettings({draftMode: mode, draftActive: true});
		this.redrawDraw(event.modifiers);
	}

	pointerMove(event: ToolPointerEvent) {
		this.lastPoint = event;
		this.lastModifiers = event.modifiers;
		this.publishHeld(event.modifiers);
		if (!this.gesture) {
			this.paintHover(event);
			return;
		}
		if (this.gesture.kind === 'ignored') return;
		if (this.gesture.kind === 'move') {
			if (event.documentPoint.x !== this.gesture.start.x || event.documentPoint.y !== this.gesture.start.y) {
				this.gesture.dragged = true;
			}
			this.redrawMove(event.documentPoint, event.modifiers);
		} else {
			this.gesture.rawPoint = event.documentPoint;
			this.redrawDraw(event.modifiers);
		}
		this.updateAutoscroll(event);
	}

	pointerUp(event: ToolPointerEvent) {
		this.stopAutoscroll();
		this.lastPoint = event;
		this.lastModifiers = event.modifiers;
		const gesture = this.gesture;
		if (gesture?.kind === 'move') {
			// A click, or a drag that rounds back to the same outline, deselects. Snapping can still move it.
			if (!gesture.dragged) this.deselect();
			else {
				this.redrawMove(event.documentPoint, event.modifiers, false);
				const preview = this.overlay?.selectionPreview ?? null;
				const origin = selectionRecord(gesture.origin, {feather: gesture.feather, antialiased: gesture.antialiased});
				if (!preview || sameSelection(origin, preview)) this.deselect();
				else this.commitRecord(preview);
			}
		} else if (gesture?.kind === 'draw') {
			gesture.rawPoint = event.documentPoint;
			const {box} = this.boxFor(gesture, event.modifiers);
			const result = applyMarquee(
				shapeFromRecord(this.context.document.selections[ACTIVE_SELECTION_ID]),
				box,
				gesture.outline,
				gesture.mode,
				this.context.document,
			);
			if (result === 'deselect') this.deselect();
			else if (result !== 'unchanged') this.commitShape(result, 0, getMarqueeToolSettings().antialiased);
		}
		this.gesture = null;
		updateMarqueeToolSettings({draftMode: null, draftActive: false});
		this.paintHover(event);
		super.pointerUp(event);
	}

	pointerCancel(reason: ToolCancelReason) {
		this.cancelDraft();
		super.pointerCancel(reason);
		if (this._status !== 'disposed') this.paintHover(this.lastPoint);
	}

	keyDown(event: ToolKeyEvent) {
		if (event.key === 'Escape') {
			this.pointerCancel('escape');
			return true;
		}
		if (event.key === 'Tab' && !event.modifiers.meta && !event.modifiers.control && !event.modifiers.alt) {
			this.cancelDraft();
			updateMarqueeToolSettings({
				kind: getMarqueeToolSettings().kind === 'rectangle' ? 'ellipse' : 'rectangle',
			});
			this.paintHover(this.lastPoint);
			return true;
		}
		if (event.key === 'Shift' || event.key === 'Alt' || event.key === 'Control' || event.key === 'Meta') {
			this.lastModifiers = event.modifiers;
			this.publishHeld(event.modifiers);
			if (this.gesture?.kind === 'draw') this.redrawDraw(event.modifiers);
			else this.paintHover(this.lastPoint);
			return true;
		}
		if (this.gesture || event.modifiers.meta || event.modifiers.control || event.modifiers.alt) return false;
		const step = event.modifiers.shift ? 10 : 1;
		const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
		const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
		if (!dx && !dy) {
			if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
			// Delete clears selected pixels. Until a raster lift exists, keep it from leaving the tool.
			return Boolean(this.context.document.selections[ACTIVE_SELECTION_ID]);
		}
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
		if (this.gesture?.kind === 'draw') this.redrawDraw(event.modifiers);
		else if (!this.gesture) this.paintHover(this.lastPoint);
		return true;
	}

	dispose() {
		this.stopAutoscroll();
		this.gesture = null;
		updateMarqueeToolSettings({draftMode: null, draftActive: false, held: null});
		super.dispose();
	}

	private cancelDraft() {
		this.stopAutoscroll();
		this.gesture = null;
		updateMarqueeToolSettings({draftMode: null, draftActive: false});
	}

	private publishHeld(modifiers: ToolModifiers) {
		const held: MarqueeMode | null = modifiers.alt ? 'subtract' : modifiers.shift ? 'add' : null;
		updateMarqueeToolSettings({held});
	}

	private boxFor(gesture: DrawGesture, modifiers: ToolModifiers) {
		if (!modifiers.shift) gesture.constrainArmed = true;
		const snapped = this.snap(gesture.rawPoint, modifiers);
		return {
			box: dragBox(gesture.anchor, snapped.point, gesture.constrainArmed && modifiers.shift, false),
			guides: snapped.guides,
		};
	}

	private redrawDraw(modifiers: ToolModifiers) {
		const gesture = this.gesture;
		if (gesture?.kind !== 'draw') return;
		const {box, guides} = this.boxFor(gesture, modifiers);
		this.overlay = {
			selectionDraft: {kind: gesture.outline === 'ellipse' ? 'ellipse' : 'rectangle', bounds: box},
			snapGuides: guides,
			canvasCursor: 'crosshair',
		};
	}

	private redrawMove(point: SelectionPoint, modifiers: ToolModifiers, commit = false) {
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
		const moved = translateShape(gesture.origin, snapped.offset.x, snapped.offset.y);
		const preview = selectionRecord(moved, {feather: gesture.feather, antialiased: gesture.antialiased});
		this.overlay = {selectionPreview: preview, snapGuides: snapped.guides, canvasCursor: 'default'};
		if (commit) this.commitRecord(preview);
	}

	private paintHover(event: ToolPointerEvent | null) {
		if (this.gesture) return;
		const shape = shapeFromRecord(this.context.document.selections[ACTIVE_SELECTION_ID]);
		const inside = Boolean(event && shape && !isEmptyShape(shape) && containsPoint(shape, event.documentPoint.x, event.documentPoint.y));
		const mode = selectionMode(getMarqueeToolSettings(), event?.modifiers.shift ?? this.lastModifiers.shift, event?.modifiers.alt ?? this.lastModifiers.alt);
		this.overlay = {
			canvasCursor: event?.modifiers.meta && inside ? (event.modifiers.alt ? 'copy' : 'not-allowed') : mode === 'replace' && inside ? 'default' : 'crosshair',
			snapGuides: [],
			selectionPreview: this.context.document.selections[ACTIVE_SELECTION_ID] ?? null,
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

	private snap(point: SelectionPoint, modifiers: ToolModifiers) {
		return snapMarqueePoint(point, this.targets(), this.tolerance(), !modifiers.control);
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
		if (!this.context.getViewport || this.gesture?.kind === 'ignored') return;
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
		if (!event || !read || !this.gesture || this.gesture.kind === 'ignored') {
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
		if (this.gesture.kind === 'draw') {
			this.gesture.rawPoint = documentPoint;
			this.redrawDraw(this.lastModifiers);
		} else if (this.gesture.kind === 'move') {
			this.gesture.dragged = true;
			this.redrawMove(documentPoint, this.lastModifiers);
		}
		this.context.notifyOverlay?.();
	}

	private stopAutoscroll() {
		if (!this.autoscroll) return;
		clearInterval(this.autoscroll);
		this.autoscroll = null;
	}
}
