import {createShapeLayer} from '../../document/defaults';
import {MARQUEE_SNAP_DISTANCE, marqueeSnapTargets, snapMarqueePoint} from '../../document/selection-geometry';
import type {DocumentState, LayerNode, ShapeLayerContent} from '../../document/types';
import {getBrushToolSettings, subscribeBrushToolSettings} from '../brush/brush-settings';
import {
	beginShapeDraft,
	commitShapeBounds,
	dragShapeDraft,
	nextShapeName,
	SHAPE_PREVIEW_ID,
	shapeDraftVisible,
	shapeInsertionOrder,
	shapeParentId,
	shapeTooLargeMessage,
	type ShapeDraft,
} from '../shape/shape-geometry';
import {
	cycleShapeKind,
	getShapeSettings,
	setShapeDraftCancel,
	setShapeError,
	subscribeShapeSettings,
} from '../shape/shape-settings';
import type {ToolCancelReason, ToolKeyEvent, ToolModifiers, ToolOverlayState, ToolPointerEvent, ToolPoint} from '../types';
import {BaseToolSession} from './base';

const finite = (point: ToolPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

/**
 * Shape (U), matching ShapeTool.swift and EditorCanvas.
 * Drag out a rectangle, ellipse, or line. Shift squares or snaps a line to 45°.
 * Option draws a rectangle or ellipse from its center. The drag previews where
 * the layer will sit, just above the active one. Releasing creates one undo
 * step and leaves the selection alone. A click with no size, Escape, and
 * switching tools create nothing. Shift-U or Tab steps through the three kinds.
 */
export class ShapeToolSession extends BaseToolSession {
	private draft: ShapeDraft | null = null;
	private dragging = false;
	private guides: NonNullable<ToolOverlayState['snapGuides']> = [];
	private readonly unsubscribe: () => void;

	constructor(context: ConstructorParameters<typeof BaseToolSession>[1]) {
		super('shape', context);
		setShapeDraftCancel(() => this.cancel());
		const onSettings = () => {
			if (this._status === 'disposed') return;
			if (this.draft) this.refresh();
			else this.publish();
			this.context.notifyOverlay?.();
		};
		const stopShape = subscribeShapeSettings(onSettings);
		const stopBrush = subscribeBrushToolSettings(onSettings);
		this.unsubscribe = () => {
			stopShape();
			stopBrush();
		};
	}

	pointerDown(event: ToolPointerEvent) {
		if (event.modifiers.space || (event.buttons & 1) !== 1 || !finite(event.documentPoint)) return;
		const snapped = this.snap(event.documentPoint, event.modifiers);
		const settings = getShapeSettings();
		const draft = beginShapeDraft(snapped.point, settings.kind, settings.cornerRadius);
		if (!draft) return;
		this.draft = draft;
		this.dragging = true;
		this.guides = snapped.guides;
		setShapeError(null);
		this._status = 'active';
		this.refresh();
	}

	pointerMove(event: ToolPointerEvent) {
		if (!this.dragging || !this.draft || !finite(event.documentPoint)) return;
		const snapped = this.snap(event.documentPoint, event.modifiers);
		this.guides = snapped.guides;
		this.draft = dragShapeDraft(this.draft, snapped.point, event.modifiers.shift, event.modifiers.alt);
		this._status = 'active';
		this.refresh();
	}

	pointerUp(_event: ToolPointerEvent) {
		void _event;
		if (!this.dragging && !this.draft) return;
		this.finish();
	}

	pointerCancel(reason: ToolCancelReason) {
		if (this._status === 'disposed') return;
		if (reason === 'lostpointercapture' && !this.dragging) return;
		if (reason === 'escape' || reason === 'tool-switch' || reason === 'unmount' || reason === 'capability') {
			this.cancel();
			return;
		}
		this.finish();
	}

	keyDown(event: ToolKeyEvent) {
		if (event.modifiers.meta || event.modifiers.control || event.modifiers.alt) return false;
		if (event.key === 'Tab' && !event.modifiers.shift) {
			cycleShapeKind();
			return true;
		}
		if (event.key.toLowerCase() === 'u' && event.modifiers.shift) {
			cycleShapeKind();
			return true;
		}
		return false;
	}

	dispose() {
		this.cancel();
		this.unsubscribe();
		setShapeDraftCancel(null);
		super.dispose();
	}

	private snap(point: ToolPoint, modifiers: ToolModifiers) {
		const viewport = this.context.getViewport?.() ?? this.context.viewport;
		const zoom = viewport.pointsPerPixel || viewport.transform.zoom || 1;
		const tolerance = MARQUEE_SNAP_DISTANCE / Math.max(zoom, 0.0001);
		return snapMarqueePoint(point, marqueeSnapTargets(this.baseDocument()), tolerance, !modifiers.control);
	}

	/** The document without the in-progress preview, so names and stacking ignore it. */
	private baseDocument() {
		const document = this.context.document;
		if (!document.layers[SHAPE_PREVIEW_ID]) return document;
		const layers = {...document.layers};
		delete layers[SHAPE_PREVIEW_ID];
		return {
			...document,
			layers,
			rootLayerIds: document.rootLayerIds.filter((id) => id !== SHAPE_PREVIEW_ID),
		};
	}

	private makeLayer(draft: ShapeDraft, id?: string): LayerNode | 'empty' | 'too-large' {
		const bounds = commitShapeBounds(draft, getShapeSettings().lineWidth);
		if (bounds === 'empty') return 'empty';
		if (bounds.status === 'too-large' && id !== SHAPE_PREVIEW_ID) return 'too-large';
		const document = this.baseDocument();
		const parentId = shapeParentId(document, this.context.activeLayerId);
		const foreground = getBrushToolSettings().foreground;
		const color = {r: foreground.r, g: foreground.g, b: foreground.b, a: 1};
		const shape: ShapeLayerContent['shape'] =
			draft.kind === 'ellipse' ? 'ellipse' : draft.kind === 'line' ? 'line' : bounds.cornerRadius > 0 ? 'rounded-rectangle' : 'rectangle';
		const layer = createShapeLayer(shape, nextShapeName(draft.kind, Object.values(document.layers).map((item) => item.name)), bounds.rect.width, bounds.rect.height);
		if (id) layer.id = id;
		layer.parentId = parentId;
		layer.order = shapeInsertionOrder(document, this.context.activeLayerId, parentId);
		layer.transform = {
			...layer.transform,
			originX: bounds.rect.x,
			originY: bounds.rect.y,
			width: bounds.rect.width,
			height: bounds.rect.height,
		};
		layer.content = {
			kind: 'shape',
			shape,
			fill: color,
			strokeWidth: draft.kind === 'line' ? bounds.lineWidth : 0,
			...(draft.kind === 'rectangle' ? {cornerRadius: bounds.cornerRadius} : {}),
			...(draft.kind === 'line' && bounds.start && bounds.end ? {stroke: color, lineStart: bounds.start, lineEnd: bounds.end} : {}),
		};
		return layer;
	}

	private withPreview(layer: LayerNode): DocumentState {
		const base = this.baseDocument();
		const layers = {...base.layers, [layer.id]: layer};
		const rootLayerIds = layer.parentId
			? base.rootLayerIds
			: Object.values(layers)
					.filter((item) => item.parentId === null)
					.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
					.map((item) => item.id);
		return {...base, layers, rootLayerIds};
	}

	private overlayShape(draft: ShapeDraft): NonNullable<ToolOverlayState['shape']> {
		const color = getBrushToolSettings().foreground;
		if (draft.kind === 'line') {
			return {
				kind: 'line',
				x: draft.rect.x,
				y: draft.rect.y,
				width: draft.rect.width,
				height: draft.rect.height,
				cornerRadius: 0,
				color,
				lineStart: draft.anchor,
				lineEnd: draft.end ?? draft.anchor,
				lineWidth: getShapeSettings().lineWidth,
			};
		}
		return {
			kind: draft.kind,
			x: draft.rect.x,
			y: draft.rect.y,
			width: draft.rect.width,
			height: draft.rect.height,
			cornerRadius: draft.cornerRadius,
			color,
		};
	}

	/** Shows the shape where its layer will go: above the active layer, under anything already above it. */
	private refresh() {
		const draft = this.draft;
		if (!draft || !shapeDraftVisible(draft)) {
			this.clearPreview();
			this.publish();
			return;
		}
		const layer = this.makeLayer(draft, SHAPE_PREVIEW_ID);
		if (layer === 'empty' || layer === 'too-large') {
			this.clearPreview();
			this.publish();
			return;
		}
		if (this.context.setMovePreview) {
			this.context.setMovePreview(this.withPreview(layer));
			this.overlay = this.guides.length ? {snapGuides: this.guides, canvasCursor: 'crosshair'} : {canvasCursor: 'crosshair'};
			return;
		}
		this.overlay = {snapGuides: this.guides, canvasCursor: 'crosshair', shape: this.overlayShape(draft)};
	}

	private finish() {
		const draft = this.draft;
		this.dragging = false;
		this.draft = null;
		this.guides = [];
		this.clearPreview();
		if (!draft) {
			if (this._status !== 'disposed') this._status = 'idle';
			this.publish();
			return;
		}
		const layer = this.makeLayer(draft);
		if (layer === 'empty') {
			if (this._status !== 'disposed') this._status = 'idle';
			this.publish();
			return;
		}
		if (layer === 'too-large') {
			setShapeError(shapeTooLargeMessage());
			this._status = 'cancelled';
			this.publish();
			return;
		}
		try {
			this.context.dispatch('layer.create', {layer});
			this.context.setSelection(layer.id);
			setShapeError(null);
			this._status = 'committed';
		} catch (error) {
			setShapeError(error instanceof Error ? error.message : '无法创建形状。');
			this._status = 'cancelled';
		}
		this.publish();
	}

	private cancel() {
		const had = this.draft !== null;
		this.draft = null;
		this.dragging = false;
		this.guides = [];
		this.clearPreview();
		if (this._status !== 'disposed' && had) this._status = 'cancelled';
		this.publish();
	}

	private clearPreview() {
		this.context.setMovePreview?.(null);
	}

	private publish() {
		if (!this.draft || !shapeDraftVisible(this.draft)) {
			this.overlay = null;
			return;
		}
		if (this.context.setMovePreview) {
			this.overlay = this.guides.length ? {snapGuides: this.guides, canvasCursor: 'crosshair'} : {canvasCursor: 'crosshair'};
			return;
		}
		this.overlay = {snapGuides: this.guides, canvasCursor: 'crosshair', shape: this.overlayShape(this.draft)};
	}
}
