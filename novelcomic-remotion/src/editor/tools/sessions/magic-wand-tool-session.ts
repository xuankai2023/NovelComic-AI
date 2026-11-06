import {
	ACTIVE_SELECTION_ID,
	MARQUEE_SNAP_DISTANCE,
	applyWand,
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
	type SelectionPoint,
} from '../../document/selection-geometry';
import type {SelectionRecord, SelectionShape} from '../../document/types';
import {selectWand, wandSampleRadius, WandError} from '../../pixels/wand';
import {viewportToDocument} from '../coordinates';
import type {ToolCancelReason, ToolKeyEvent, ToolModifiers, ToolPointerEvent} from '../types';
import {wandDrawCursor, wandMoveCursor} from '../wand/wand-cursors';
import {
	getWandToolSettings,
	setWandError,
	updateWandToolSettings,
	type WandToolSettings,
} from '../wand/wand-settings';
import {BaseToolSession} from './base';

type MoveGesture = {
	kind: 'move';
	origin: SelectionShape;
	feather: number;
	antialiased: boolean;
	start: SelectionPoint;
};

type IgnoredGesture = {kind: 'ignored'};

type Gesture = MoveGesture | IgnoredGesture;

const selectionMode = (settings: WandToolSettings, shift: boolean, alt: boolean): MarqueeMode =>
	alt ? 'subtract' : shift ? 'add' : settings.mode;

const finitePoint = (point: SelectionPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

/**
 * Magic Wand, following Compositor's MagicWand.swift and the wand branches of
 * EditorCanvas. A click selects similar pixels. In New mode a press inside the
 * selection moves it, and a click that does not move selects afresh from that pixel.
 */
export class MagicWandToolSession extends BaseToolSession {
	private gesture: Gesture | null = null;
	private lastPoint: ToolPointerEvent | null = null;
	private lastModifiers: ToolModifiers = {shift: false, alt: false, meta: false, control: false, space: false};
	private autoscroll: ReturnType<typeof setInterval> | null = null;

	constructor(context: ConstructorParameters<typeof BaseToolSession>[1]) {
		super('magic-wand', context);
		this.paintHover(null);
	}

	sync() {
		if (!this.gesture) this.paintHover(this.lastPoint);
	}

	pointerDown(event: ToolPointerEvent) {
		super.pointerDown(event);
		this.lastPoint = event;
		this.lastModifiers = event.modifiers;
		this.publishHeld(event.modifiers);
		const settings = getWandToolSettings();
		const mode = selectionMode(settings, event.modifiers.shift, event.modifiers.alt);
		const shape = shapeFromRecord(this.context.document.selections[ACTIVE_SELECTION_ID]);
		const inside = Boolean(shape && !isEmptyShape(shape) && containsPoint(shape, event.documentPoint.x, event.documentPoint.y));
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
			};
			this.overlay = {canvasCursor: wandMoveCursor, selectionPreview: record};
			return;
		}
		this.selectAt(event.documentPoint, mode);
		this.paintHover(event);
	}

	pointerMove(event: ToolPointerEvent) {
		this.lastPoint = event;
		this.lastModifiers = event.modifiers;
		this.publishHeld(event.modifiers);
		if (this.gesture?.kind !== 'move') {
			if (!this.gesture) this.paintHover(event);
			return;
		}
		this.redrawMove(event.documentPoint, event.modifiers);
		this.updateAutoscroll(event);
	}

	pointerUp(event: ToolPointerEvent) {
		this.stopAutoscroll();
		this.lastPoint = event;
		this.lastModifiers = event.modifiers;
		const gesture = this.gesture;
		this.gesture = null;
		if (gesture?.kind === 'move') {
			const moved = this.movedRecord(gesture, event.documentPoint, event.modifiers);
			const origin = selectionRecord(gesture.origin, {feather: gesture.feather, antialiased: gesture.antialiased});
			// A click inside, or a drag that lands back on the same outline, selects from that pixel.
			if (sameSelection(origin, moved.record)) this.selectAt(gesture.start, 'replace');
			else this.commitRecord(moved.record);
		}
		this.paintHover(event);
		super.pointerUp(event);
	}

	pointerCancel(reason: ToolCancelReason) {
		this.stopAutoscroll();
		this.gesture = null;
		super.pointerCancel(reason);
		if (this._status !== 'disposed') this.paintHover(this.lastPoint);
	}

	keyDown(event: ToolKeyEvent) {
		if (event.key === 'Escape') {
			this.pointerCancel('escape');
			return true;
		}
		if (event.key === 'Shift' || event.key === 'Alt' || event.key === 'Control' || event.key === 'Meta') {
			this.lastModifiers = event.modifiers;
			this.publishHeld(event.modifiers);
			if (!this.gesture) this.paintHover(this.lastPoint);
			return true;
		}
		if (this.gesture || event.modifiers.meta || event.modifiers.control || event.modifiers.alt) return false;
		const step = event.modifiers.shift ? 10 : 1;
		const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
		const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
		if (!dx && !dy) {
			if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
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
		if (!this.gesture) this.paintHover(this.lastPoint);
		return true;
	}

	dispose() {
		this.stopAutoscroll();
		this.gesture = null;
		updateWandToolSettings({held: null});
		super.dispose();
	}

	private publishHeld(modifiers: ToolModifiers) {
		const held: MarqueeMode | null = modifiers.alt ? 'subtract' : modifiers.shift ? 'add' : null;
		updateWandToolSettings({held});
	}

	private selectAt(point: SelectionPoint, mode: MarqueeMode) {
		const document = this.context.document;
		if (!finitePoint(point) || point.x < 0 || point.y < 0 || point.x >= document.width || point.y >= document.height) return;
		setWandError(null);
		const settings = getWandToolSettings();
		const sample = this.context.readWandSample?.(settings.sampleAllLayers) ?? null;
		if (!sample || sample.width !== document.width || sample.height !== document.height) {
			setWandError('还读不到图层像素。');
			return;
		}
		let loops: ReturnType<typeof selectWand>;
		try {
			loops = selectWand(sample, point, {
				tolerance: settings.tolerance,
				radius: wandSampleRadius(settings.sampleSize),
				contiguous: settings.contiguous,
			});
		} catch (error) {
			setWandError(error instanceof WandError ? error.message : '无法建立这个选区。');
			return;
		}
		const result = applyWand(shapeFromRecord(document.selections[ACTIVE_SELECTION_ID]), loops, mode, document);
		if (result === 'deselect') this.deselect();
		else if (result !== 'unchanged') this.commitShape(result, 0, settings.antialiased);
	}

	private movedRecord(gesture: MoveGesture, point: SelectionPoint, modifiers: ToolModifiers) {
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
		return {
			record: selectionRecord(moved, {feather: gesture.feather, antialiased: gesture.antialiased}),
			guides: snapped.guides,
		};
	}

	private redrawMove(point: SelectionPoint, modifiers: ToolModifiers) {
		const gesture = this.gesture;
		if (gesture?.kind !== 'move') return;
		const moved = this.movedRecord(gesture, point, modifiers);
		this.overlay = {selectionPreview: moved.record, snapGuides: moved.guides, canvasCursor: wandMoveCursor};
	}

	private paintHover(event: ToolPointerEvent | null) {
		if (this.gesture) return;
		const shape = shapeFromRecord(this.context.document.selections[ACTIVE_SELECTION_ID]);
		const inside = Boolean(event && shape && !isEmptyShape(shape) && containsPoint(shape, event.documentPoint.x, event.documentPoint.y));
		const mode = selectionMode(
			getWandToolSettings(),
			event?.modifiers.shift ?? this.lastModifiers.shift,
			event?.modifiers.alt ?? this.lastModifiers.alt,
		);
		const meta = event?.modifiers.meta ?? this.lastModifiers.meta;
		this.overlay = {
			canvasCursor: meta && inside ? (event?.modifiers.alt || this.lastModifiers.alt ? 'copy' : 'not-allowed') : mode === 'replace' && inside ? wandMoveCursor : wandDrawCursor(mode),
			snapGuides: [],
			selectionPreview: this.context.document.selections[ACTIVE_SELECTION_ID] ?? null,
		};
		this.context.notifyOverlay?.();
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
		if (!this.context.getViewport || this.gesture?.kind !== 'move') return;
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
		this.redrawMove(viewportToDocument(event.viewportPoint, read()), this.lastModifiers);
		this.context.notifyOverlay?.();
	}

	private stopAutoscroll() {
		if (!this.autoscroll) return;
		clearInterval(this.autoscroll);
		this.autoscroll = null;
	}
}
