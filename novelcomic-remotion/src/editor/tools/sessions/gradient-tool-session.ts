import {ACTIVE_SELECTION_ID, isEmptyShape, selectionCoverage, shapeFromRecord} from '../../document/selection-geometry';
import type {LayerTransform} from '../../document/types';
import {getBrushToolSettings, setBrushForeground, subscribeBrushToolSettings} from '../brush/brush-settings';
import {clearBrushOverride, rasterAssetFromPixels, resolveBrushPixels, setBrushOverride} from '../brush/brush-pixels';
import {makeBrushSpace} from '../brush/brush-stroke';
import {paintTarget} from '../brush/paint-target';
import {paintGradient} from '../gradient/gradient-pixels';
import {
	cycleGradientShape,
	getGradientSettings,
	gradientColorStops,
	setGradientEdit,
	setGradientError,
	snapTo45,
	subscribeGradientSettings,
	typeGradientOpacityDigit,
} from '../gradient/gradient-settings';
import type {ToolCancelReason, ToolKeyEvent, ToolPointerEvent, ToolPoint, ToolSessionContext} from '../types';
import {BaseToolSession} from './base';

type Handle = 'start' | 'end';

type Draft = {
	start: ToolPoint;
	end: ToolPoint;
	layerId: string;
	assetId: string;
	transform: LayerTransform;
};

const finite = (point: ToolPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

const sameTransform = (left: LayerTransform, right: LayerTransform) =>
	left.originX === right.originX &&
	left.originY === right.originY &&
	left.width === right.width &&
	left.height === right.height &&
	left.rotation === right.rotation &&
	left.scaleX === right.scaleX &&
	left.scaleY === right.scaleY;

const layerIds = (ids: readonly string[]) => [...ids].sort().join('\0');

/** View points. The end is tested first, matching EditorCanvas.beginGradientDrag. */
const HANDLE_RADIUS = 10;

/**
 * Gradient, matching Compositor. The drag is the ramp. A click with no length
 * drops the line. Enter or leaving the tool writes one undo step; Escape and
 * the first Undo throw it away.
 */
export class GradientToolSession extends BaseToolSession {
	private draft: Draft | null = null;
	private dragging: Handle | null = null;
	private sampling = false;
	private readonly editActions = {
		commit: () => this.commit(),
		cancel: () => this.cancel(),
	};
	private readonly unsubscribe: () => void;

	constructor(context: ConstructorParameters<typeof BaseToolSession>[1]) {
		super('gradient', context);
		const onSettings = () => {
			if (this._status === 'disposed') return;
			if (this.draft) this.preview();
			this.publish();
			this.context.notifyOverlay?.();
		};
		const stopGradient = subscribeGradientSettings(onSettings);
		const stopBrush = subscribeBrushToolSettings(onSettings);
		this.unsubscribe = () => {
			stopGradient();
			stopBrush();
		};
	}

	updateContext(context: ToolSessionContext) {
		if (this._status === 'disposed') return;
		const layerChanged = context.activeLayerId !== this.context.activeLayerId;
		const selectionChanged = layerIds(context.selectedLayerIds) !== layerIds(this.context.selectedLayerIds);
		this.context = context;
		if ((layerChanged || selectionChanged) && this.draft) {
			queueMicrotask(() => {
				if (this._status === 'disposed' || !this.draft) return;
				this.resolve();
			});
		}
	}

	pointerDown(event: ToolPointerEvent) {
		if (!finite(event.documentPoint)) return;
		if (event.modifiers.alt) {
			this.sampling = true;
			this._status = 'active';
			this.sample(event.documentPoint);
			this.publish();
			return;
		}
		const handle = this.hit(event.documentPoint);
		if (handle && this.draft) {
			this.dragging = handle;
			this.moveHandle(handle, event);
			return;
		}
		this.begin(event);
	}

	pointerMove(event: ToolPointerEvent) {
		if (!finite(event.documentPoint)) return;
		if (this.sampling) {
			this.sample(event.documentPoint);
			return;
		}
		if (!this.dragging || !this.draft) return;
		this.moveHandle(this.dragging, event);
	}

	pointerUp(event: ToolPointerEvent) {
		if (this.sampling) {
			this.sampling = false;
			this._status = this.draft ? 'active' : 'idle';
			this.publish();
			return;
		}
		if (this.dragging && this.draft && finite(event.documentPoint)) this.moveHandle(this.dragging, event);
		this.endDrag();
	}

	pointerCancel(reason: ToolCancelReason) {
		if (this._status === 'disposed') return;
		if (reason === 'lostpointercapture' && !this.dragging && !this.sampling) return;
		if (reason === 'escape') {
			this.cancel();
			return;
		}
		if (reason === 'tool-switch' || reason === 'unmount') {
			this.resolve();
			return;
		}
		this.sampling = false;
		this.endDrag();
	}

	keyDown(event: ToolKeyEvent) {
		if (event.modifiers.meta || event.modifiers.control || event.modifiers.alt) return false;
		if (event.key === 'Tab') {
			cycleGradientShape();
			return true;
		}
		if (event.key === 'Enter') {
			if (!this.draft) return false;
			this.dragging = null;
			this.commit();
			return true;
		}
		if (event.key >= '0' && event.key <= '9') return typeGradientOpacityDigit(Number(event.key));
		return false;
	}

	dispose() {
		this.resolve();
		this.unsubscribe();
		setGradientEdit(null);
		super.dispose();
	}

	private begin(event: ToolPointerEvent) {
		const point = {x: event.documentPoint.x, y: event.documentPoint.y};
		if (this.sameTarget()) {
			const draft = this.draft;
			if (!draft) return;
			draft.start = point;
			draft.end = point;
			this.dragging = 'end';
			this._status = 'active';
			setGradientError(null);
			this.publish();
			return;
		}
		if (this.draft) return;
		const target = paintTarget(this.context);
		if (!target.ok) {
			setGradientError(target.reason);
			this._status = 'idle';
			this.publish();
			return;
		}
		const pixels = resolveBrushPixels(target.asset);
		if (!pixels) {
			setGradientError(`「${target.layer.name}」的图像还在加载。`);
			this._status = 'idle';
			this.publish();
			return;
		}
		setGradientError(null);
		this.draft = {
			start: point,
			end: point,
			layerId: target.layer.id,
			assetId: target.asset.id,
			transform: {...target.layer.transform},
		};
		this.dragging = 'end';
		this._status = 'active';
		this.bindEdit();
		this.publish();
	}

	private moveHandle(handle: Handle, event: ToolPointerEvent) {
		const draft = this.draft;
		if (!draft) return;
		const fixed = handle === 'end' ? draft.start : draft.end;
		const next = event.modifiers.shift ? snapTo45(fixed, event.documentPoint) : {x: event.documentPoint.x, y: event.documentPoint.y};
		if (handle === 'end') draft.end = next;
		else draft.start = next;
		this._status = 'active';
		this.preview();
		this.publish();
	}

	/** Releases the pointer. A click that never drew a line leaves nothing pending. */
	private endDrag() {
		this.dragging = null;
		this.sampling = false;
		if (!this.draft) {
			if (this._status !== 'disposed') this._status = 'idle';
			this.publish();
			return;
		}
		if (!this.hasLine()) {
			this.cancel();
			return;
		}
		this._status = 'active';
		this.publish();
	}

	private hit(point: ToolPoint): Handle | null {
		const draft = this.draft;
		if (!draft || !this.hasLine(draft)) return null;
		const zoom = Math.max(0.01, this.context.viewport.transform.zoom);
		const radius = HANDLE_RADIUS / zoom;
		const distance = (end: ToolPoint) => Math.hypot(point.x - end.x, point.y - end.y);
		if (distance(draft.end) <= radius) return 'end';
		if (distance(draft.start) <= radius) return 'start';
		return null;
	}

	private hasLine(draft = this.draft) {
		if (!draft) return false;
		return Math.hypot(draft.end.x - draft.start.x, draft.end.y - draft.start.y) >= 0.5;
	}

	private sameTarget() {
		const draft = this.draft;
		if (!draft) return false;
		const layer = this.context.activeLayerId ? this.context.document.layers[this.context.activeLayerId] : undefined;
		const assetId = layer?.content.kind === 'pixel' ? layer.content.assetId : null;
		return Boolean(layer && layer.id === draft.layerId && assetId === draft.assetId);
	}

	private sample(point: ToolPoint) {
		const sampled = this.context.sampleComposite?.(point);
		if (sampled) {
			setBrushForeground({r: sampled.r, g: sampled.g, b: sampled.b});
			return;
		}
		const target = paintTarget(this.context);
		if (!target.ok || target.layer.content.kind !== 'pixel') return;
		const pixels = resolveBrushPixels(target.asset);
		const space = pixels && makeBrushSpace(this.context.document, target.layer, pixels.width, pixels.height);
		const pixel = space?.toPixel(point);
		if (!pixels || !pixel) return;
		const x = Math.floor(pixel.x);
		const y = Math.floor(pixel.y);
		if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return;
		const offset = (y * pixels.width + x) * 4;
		setBrushForeground({r: pixels.data[offset] ?? 0, g: pixels.data[offset + 1] ?? 0, b: pixels.data[offset + 2] ?? 0});
	}

	private selectionOf(space: NonNullable<ReturnType<typeof makeBrushSpace>>) {
		const selection = this.context.document.selections[ACTIVE_SELECTION_ID];
		const shape = shapeFromRecord(selection);
		if (!shape || isEmptyShape(shape)) return undefined;
		const antialiased = selection?.geometry?.antialiased ?? true;
		const inverted = selection?.inverted === true;
		return (x: number, y: number) => {
			const documentPoint = space.toDocument({x, y});
			if (!documentPoint) return 0;
			const amount = selectionCoverage(shape, Math.floor(documentPoint.x), Math.floor(documentPoint.y), {antialiased}) / 255;
			return inverted ? 1 - amount : amount;
		};
	}

	private render() {
		const draft = this.draft;
		if (!draft || !this.hasLine(draft)) return null;
		const layer = this.context.document.layers[draft.layerId];
		const assetId = layer?.content.kind === 'pixel' ? layer.content.assetId : null;
		const asset = assetId ? this.context.document.assets[assetId] : undefined;
		if (!layer || assetId !== draft.assetId || !asset || asset.kind !== 'raster') return null;
		if (!sameTransform(layer.transform, draft.transform)) return null;
		const pixels = resolveBrushPixels(asset);
		if (!pixels) return null;
		const space = makeBrushSpace(this.context.document, layer, pixels.width, pixels.height);
		if (!space) return null;
		const {from, to} = gradientColorStops(getBrushToolSettings().foreground, getBrushToolSettings().background);
		return paintGradient(pixels, {
			start: draft.start,
			end: draft.end,
			shape: getGradientSettings().shape,
			from,
			to,
			opacity: getGradientSettings().opacity,
			at: (x, y) => space.toDocument({x: x + 0.5, y: y + 0.5}),
			coverage: this.selectionOf(space),
		});
	}

	/** Keeps the previous fill until the new segment is long enough to replace it. */
	private preview() {
		const draft = this.draft;
		if (!draft || !this.hasLine(draft)) return;
		const pixels = this.render();
		if (!pixels) {
			clearBrushOverride(draft.assetId);
			return;
		}
		setBrushOverride(draft.assetId, pixels);
	}

	/** Switching tools, layers, or targets applies the pending gradient. */
	private resolve() {
		if (!this.draft) return;
		this.dragging = null;
		this.commit();
	}

	private commit() {
		const draft = this.draft;
		if (!draft) return;
		if (!this.hasLine(draft)) {
			this.cancel();
			return;
		}
		const pixels = this.render();
		if (!pixels) {
			this.cancel();
			return;
		}
		const {layerId, assetId} = draft;
		this.draft = null;
		this.dragging = null;
		this.sampling = false;
		try {
			this.context.dispatch('pixel.replace', {layerId, asset: rasterAssetFromPixels(pixels)});
			clearBrushOverride(assetId);
			this._status = 'committed';
		} catch (error) {
			clearBrushOverride(assetId);
			setGradientError(error instanceof Error ? error.message : '无法应用渐变。');
			this._status = 'cancelled';
		}
		this.publish();
		this.bindEdit();
	}

	private cancel() {
		const assetId = this.draft?.assetId;
		this.draft = null;
		this.dragging = null;
		this.sampling = false;
		if (assetId) clearBrushOverride(assetId);
		if (this._status !== 'disposed') this._status = 'cancelled';
		this.publish();
		this.bindEdit();
	}

	private bindEdit() {
		setGradientEdit(this.draft ? this.editActions : null);
	}

	private publish() {
		const draft = this.draft;
		if (!draft || !this.hasLine(draft)) {
			this.overlay = null;
			return;
		}
		const {from, to} = gradientColorStops(getBrushToolSettings().foreground, getBrushToolSettings().background);
		this.overlay = {
			gradient: {
				start: {...draft.start},
				end: {...draft.end},
				shape: getGradientSettings().shape,
				from,
				to,
			},
		};
	}
}
