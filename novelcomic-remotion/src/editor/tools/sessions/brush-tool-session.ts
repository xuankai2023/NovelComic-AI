import {createDocumentCommand} from '../../commands/document-command-types';
import {ACTIVE_SELECTION_ID, selectionCoverage, shapeFromRecord} from '../../document/selection-geometry';
import type {LayerTransform} from '../../document/types';
import {
	changeBrushHardness,
	changeBrushSize,
	cycleHealingMode,
	getBrushToolSettings,
	getLastBrushPoint,
	setBrushError,
	setBrushForeground,
	setBrushMode,
	setBrushStrokeActive,
	setLastBrushPoint,
	typeBrushOpacityDigit,
	updateBrushToolSettings,
} from '../brush/brush-settings';
import {clearBrushOverride, rasterAssetFromPixels, resolveBrushPixels, setBrushOverride} from '../brush/brush-pixels';
import {BrushStroke, makeBrushSpace, prepareBrushSurface} from '../brush/brush-stroke';
import {
	CLONE_SAMPLE_EMPTY,
	CLONE_SOURCE_REQUIRED,
	cloneSamplePoint,
	cloneStrokeOffset,
	createCloneSampler,
	getCloneSettings,
	renderClonePreview,
	setCloneOffset,
	setCloneSource,
	toggleCloneSample,
} from '../brush/clone-stamp';
import {paintTarget} from '../brush/paint-target';
import type {ToolCancelReason, ToolKeyEvent, ToolPointerEvent, ToolPoint} from '../types';
import {BaseToolSession} from './base';

type TipDrag = {anchor: ToolPoint; viewportX: number; diameter: number; hardness: number};

const sameTransform = (left: LayerTransform, right: LayerTransform) =>
	left.originX === right.originX &&
	left.originY === right.originY &&
	left.width === right.width &&
	left.height === right.height &&
	left.rotation === right.rotation &&
	left.scaleX === right.scaleX &&
	left.scaleY === right.scaleY;

const finite = (point: ToolPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

/**
 * Brush, eraser, spot healing, and clone stamp. They share Compositor's brush gesture:
 * one stroke is one undo, Shift locks an axis or continues from the last point, and a
 * right-drag resizes the tip. Option samples a color, except Clone Stamp, where it sets
 * the source. Spot healing and cloning do not smooth; healing rebuilds the painted area
 * from nearby texture when the button is released.
 */
export class BrushToolSession extends BaseToolSession {
	private stroke: BrushStroke | null = null;
	private sourceAssetId: string | null = null;
	private layerId: string | null = null;
	private transform: LayerTransform | null = null;
	private nextTransform: LayerTransform | null = null;
	private anchor: ToolPoint | null = null;
	private pointer: ToolPoint | null = null;
	private cursorPoint: ToolPoint | null = null;
	private showHardness = false;
	private axisAnchor: ToolPoint | null = null;
	private axisHorizontal: boolean | null = null;
	private tip: TipDrag | null = null;
	private sampling = false;
	private optionHeld = false;
	private previewKey = '';
	private previewImage: {width: number; height: number; data: Uint8ClampedArray} | null = null;

	constructor(
		context: ConstructorParameters<typeof BaseToolSession>[1],
		private readonly kind: 'brush' | 'healing' | 'clone' = 'brush',
	) {
		super(kind === 'clone' ? 'clone-stamp' : kind, context);
		this.publish();
	}

	sync() {
		if (!this.stroke) this.publish();
	}

	pointerDown(event: ToolPointerEvent) {
		this.cursorPoint = finite(event.documentPoint) ? {...event.documentPoint} : this.cursorPoint;
		if (this.kind === 'clone') this.optionHeld = event.modifiers.alt;
		if ((event.buttons & 2) === 2) {
			this.beginTip(event);
			return;
		}
		if (event.modifiers.alt) {
			if (this.kind === 'clone') this.pickSource(event.documentPoint);
			else this.beginSample(event);
			return;
		}
		this.beginStroke(event);
	}

	pointerMove(event: ToolPointerEvent) {
		if (this.kind === 'clone') this.optionHeld = event.modifiers.alt;
		if (!finite(event.documentPoint)) return;
		if (this.tip) {
			this.dragTip(event);
			return;
		}
		if (this.sampling) {
			this.sample(event.documentPoint);
			this.cursorPoint = {...event.documentPoint};
			this.publish();
			return;
		}
		if (this.stroke) {
			this.continueStroke(this.constrained(event));
			return;
		}
		this.cursorPoint = {...event.documentPoint};
		this.publish();
	}

	pointerUp(event: ToolPointerEvent) {
		if (this.kind === 'clone') this.optionHeld = event.modifiers.alt;
		if (this.tip) {
			this.tip = null;
			this.showHardness = false;
			this.cursorPoint = finite(event.documentPoint) ? {...event.documentPoint} : this.cursorPoint;
			this._status = 'idle';
			this.publish();
			return;
		}
		if (this.sampling) {
			this.sampling = false;
			this._status = 'idle';
			this.publish();
			return;
		}
		if (!this.stroke) {
			this._status = 'idle';
			this.publish();
			return;
		}
		this.finishStroke();
	}

	pointerCancel(_reason: ToolCancelReason) {
		this.tip = null;
		this.sampling = false;
		this.showHardness = false;
		this.discardStroke();
		if (this._status !== 'disposed') this._status = 'cancelled';
		this.publish();
	}

	keyDown(event: ToolKeyEvent) {
		if (this.kind === 'clone' && (event.key === 'Alt' || event.key === 'AltLeft' || event.key === 'AltRight')) {
			this.optionHeld = true;
			this.publish();
			return true;
		}
		if (event.modifiers.meta || event.modifiers.control || event.modifiers.alt) return false;
		if (event.key === 'Tab') {
			if (!this.stroke) {
				if (this.kind === 'healing') cycleHealingMode();
				else if (this.kind === 'clone') toggleCloneSample();
				else setBrushMode(getBrushToolSettings().mode === 'paint' ? 'erase' : 'paint');
			}
			this.publish();
			return true;
		}
		if (event.key >= '0' && event.key <= '9') {
			const handled = typeBrushOpacityDigit(Number(event.key));
			this.publish();
			return handled;
		}
		if (event.key === '[') return changeBrushSize(false) && (this.publish(), true);
		if (event.key === ']') return changeBrushSize(true) && (this.publish(), true);
		if (event.key === '{') return changeBrushHardness(false) && (this.publish(), true);
		if (event.key === '}') return changeBrushHardness(true) && (this.publish(), true);
		return false;
	}

	keyUp(event: ToolKeyEvent) {
		if (this.kind === 'clone' && (event.key === 'Alt' || event.key === 'AltLeft' || event.key === 'AltRight')) {
			this.optionHeld = false;
			this.publish();
			return true;
		}
		return false;
	}

	dispose() {
		this.discardStroke();
		super.dispose();
	}

	private beginTip(event: ToolPointerEvent) {
		if (this.stroke) return;
		const settings = getBrushToolSettings();
		this.tip = {
			anchor: {...event.documentPoint},
			viewportX: event.viewportPoint.x,
			diameter: settings.diameter,
			hardness: settings.hardness,
		};
		this.cursorPoint = this.tip.anchor;
		this.showHardness = event.modifiers.shift;
		this._status = 'active';
		this.publish();
	}

	private dragTip(event: ToolPointerEvent) {
		if (!this.tip) return;
		this.showHardness = event.modifiers.shift;
		const dx = event.viewportPoint.x - this.tip.viewportX;
		if (event.modifiers.shift) {
			updateBrushToolSettings({hardness: this.tip.hardness + dx / 200, diameter: this.tip.diameter});
		} else {
			const perPixel = Math.max(0.0001, this.context.viewport.pointsPerPixel);
			updateBrushToolSettings({diameter: this.tip.diameter + (2 * dx) / perPixel, hardness: this.tip.hardness});
		}
		this.cursorPoint = this.tip.anchor;
		this.publish();
	}

	/** Option-click sets where Clone Stamp copies from. It does not start a stroke. */
	private pickSource(point: ToolPoint) {
		if (!finite(point)) return;
		setCloneSource(point);
		setBrushError(null);
		this.cursorPoint = {...point};
		this._status = 'idle';
		this.publish();
	}

	private beginSample(event: ToolPointerEvent) {
		this.sampling = true;
		this._status = 'active';
		this.sample(event.documentPoint);
		this.cursorPoint = {...event.documentPoint};
		this.publish();
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

	private beginStroke(event: ToolPointerEvent) {
		const target = paintTarget(this.context);
		if (!target.ok) {
			setBrushError(target.reason);
			this._status = 'idle';
			this.publish();
			return;
		}
		const pixels = resolveBrushPixels(target.asset);
		if (!pixels) {
			setBrushError(`「${target.layer.name}」的图像还在加载。`);
			this._status = 'idle';
			this.publish();
			return;
		}
		const settings = getBrushToolSettings();
		const from = event.modifiers.shift ? getLastBrushPoint() : null;
		const start = from && from.layerId === target.layer.id ? from.point : event.documentPoint;
		const selection = this.context.document.selections[ACTIVE_SELECTION_ID];
		const shape = shapeFromRecord(selection);
		const antialiased = selection?.geometry?.antialiased ?? true;
		const inverted = selection?.inverted === true;
		let prepared: ReturnType<typeof prepareBrushSurface>;
		try {
			prepared = prepareBrushSurface(this.context.document, target.layer, pixels);
			if (!prepared) throw new Error(`「${target.layer.name}」的位置无效，无法绘画。`);
			this.stroke = new BrushStroke(
				prepared.pixels,
				{
					diameter: settings.diameter,
					hardness: settings.hardness,
					opacity: settings.opacity,
					erasing: this.kind === 'brush' && settings.mode === 'erase',
					healing: this.kind === 'healing',
					healingMode: settings.healingMode,
					color: settings.foreground,
				},
				prepared.space,
				shape
					? (x, y) => {
							const coverage = selectionCoverage(shape, Math.floor(x), Math.floor(y), {antialiased}) / 255;
							return inverted ? 1 - coverage : coverage;
						}
					: undefined,
			);
			if (this.kind === 'clone') {
				const offset = cloneStrokeOffset(start);
				if (!offset) throw new Error(CLONE_SOURCE_REQUIRED);
				const sampler = createCloneSampler({
					document: this.context.document,
					layer: target.layer,
					pixels: prepared.pixels,
					space: prepared.space,
					offset,
				});
				if (!sampler) throw new Error(CLONE_SAMPLE_EMPTY);
				this.stroke.useClone(sampler);
				setCloneOffset(offset);
			}
		} catch (error) {
			this.stroke = null;
			setBrushError(error instanceof Error ? error.message : '无法开始绘画。');
			this._status = 'idle';
			this.publish();
			return;
		}
		setBrushError(null);
		setBrushStrokeActive(true);
		this.sourceAssetId = target.asset.id;
		this.layerId = target.layer.id;
		this.transform = {...target.layer.transform};
		this.nextTransform = prepared.transform;
		this._status = 'active';
		this.anchor = {...start};
		this.pointer = {...event.documentPoint};
		this.cursorPoint = {...event.documentPoint};
		this.axisAnchor = event.modifiers.shift ? {...event.documentPoint} : null;
		this.axisHorizontal = null;
		this.stroke.append(start);
		setLastBrushPoint(start, target.layer.id);
		this.showSurface();
		if (start.x !== event.documentPoint.x || start.y !== event.documentPoint.y) this.continueStroke(event.documentPoint);
		else this.preview();
		this.publish();
	}

	private constrained(event: ToolPointerEvent) {
		let pixel = {...event.documentPoint};
		if (event.modifiers.shift) {
			const anchor = this.axisAnchor ?? this.pointer ?? pixel;
			if (!this.axisAnchor) {
				this.axisAnchor = anchor;
				this.axisHorizontal = null;
			}
			if (this.axisHorizontal === null && Math.hypot(pixel.x - anchor.x, pixel.y - anchor.y) >= 3) {
				this.axisHorizontal = Math.abs(pixel.x - anchor.x) >= Math.abs(pixel.y - anchor.y);
			}
			pixel = this.axisHorizontal === null ? anchor : this.axisHorizontal ? {x: pixel.x, y: anchor.y} : {x: anchor.x, y: pixel.y};
		} else {
			this.axisAnchor = null;
			this.axisHorizontal = null;
		}
		return pixel;
	}

	private continueStroke(point: ToolPoint) {
		if (!this.stroke || !this.layerId) return;
		this.pointer = {...point};
		this.cursorPoint = {...point};
		const painted = this.smoothed(point);
		if (painted) {
			this.stroke.append(painted);
			setLastBrushPoint(painted, this.layerId);
			this.preview();
		}
		this.publish();
	}

	/** The brush trails the pointer on a string. While the string is slack, jitters never reach the stroke. */
	private smoothed(point: ToolPoint) {
		if (this.kind !== 'brush') return point;
		const smoothing = getBrushToolSettings().smoothing;
		if (smoothing <= 0 || !this.anchor) return point;
		const radius = smoothing / Math.max(0.01, this.context.viewport.transform.zoom);
		const dx = point.x - this.anchor.x;
		const dy = point.y - this.anchor.y;
		const distance = Math.hypot(dx, dy);
		if (distance <= radius) return null;
		const step = (distance - radius) / distance;
		const moved = {x: this.anchor.x + dx * step, y: this.anchor.y + dy * step};
		this.anchor = moved;
		return moved;
	}

	private preview() {
		if (this.stroke && this.sourceAssetId) setBrushOverride(this.sourceAssetId, this.stroke.pixels);
	}

	/** While the bitmap is larger than the layer, draw it in the grown placement. */
	private showSurface() {
		if (!this.layerId || !this.transform || !this.nextTransform || sameTransform(this.transform, this.nextTransform)) return;
		const current = this.context.document;
		const layer = current.layers[this.layerId];
		if (!layer || sameTransform(layer.transform, this.nextTransform)) return;
		this.context.setMovePreview?.({
			...current,
			layers: {...current.layers, [this.layerId]: {...layer, transform: this.nextTransform}},
		});
	}

	private finishStroke() {
		const stroke = this.stroke;
		const assetId = this.sourceAssetId;
		const layerId = this.layerId;
		const transform = this.transform;
		const nextTransform = this.nextTransform;
		if (!stroke || !assetId || !layerId || !transform || !nextTransform) {
			this.discardStroke();
			return;
		}
		let repaired = true;
		try {
			if (
				this.kind === 'brush' &&
				this.pointer &&
				this.anchor &&
				getBrushToolSettings().smoothing > 0 &&
				(this.pointer.x !== this.anchor.x || this.pointer.y !== this.anchor.y)
			) {
				stroke.append(this.pointer);
				setLastBrushPoint(this.pointer, layerId);
			}
			stroke.flush();
			if (this.kind === 'healing') stroke.heal();
		} catch (error) {
			repaired = false;
			setBrushError(error instanceof Error ? error.message : '无法完成修复。');
		}
		try {
			const layer = this.context.document.layers[layerId];
			const currentAssetId = layer?.content.kind === 'pixel' ? layer.content.assetId : null;
			const live = layer?.transform;
			const stillThisStroke = Boolean(live && (sameTransform(live, transform) || sameTransform(live, nextTransform)));
			if (repaired && stroke.changed && layer && currentAssetId === assetId && stillThisStroke) {
				this.preview();
				const asset = rasterAssetFromPixels(stroke.pixels);
				const replace = createDocumentCommand({
					type: 'pixel.replace',
					payload: {layerId, asset},
					projectId: this.context.document.projectId,
				});
				if (sameTransform(transform, nextTransform)) this.context.dispatch('pixel.replace', {layerId, asset});
				else {
					this.context.dispatchCommands([
						replace,
						createDocumentCommand({
							type: 'layer.transform',
							payload: {layerId, transform: nextTransform},
							projectId: this.context.document.projectId,
						}),
					]);
				}
			}
		} finally {
			this.stroke = null;
			this.sourceAssetId = null;
			this.layerId = null;
			this.transform = null;
			this.nextTransform = null;
			this.anchor = null;
			this.pointer = null;
			this.axisAnchor = null;
			this.axisHorizontal = null;
			setBrushStrokeActive(false);
			clearBrushOverride(assetId);
			this.context.setMovePreview?.(null);
			this._status = repaired ? 'committed' : 'cancelled';
			this.publish();
		}
	}

	private discardStroke() {
		const assetId = this.sourceAssetId;
		this.stroke = null;
		this.sourceAssetId = null;
		this.layerId = null;
		this.transform = null;
		this.nextTransform = null;
		this.anchor = null;
		this.pointer = null;
		this.axisAnchor = null;
		this.axisHorizontal = null;
		setBrushStrokeActive(false);
		if (assetId) clearBrushOverride(assetId);
		this.context.setMovePreview?.(null);
	}

	private publish() {
		const settings = getBrushToolSettings();
		const point = this.cursorPoint;
		const clone = this.kind === 'clone' ? getCloneSettings() : null;
		const sample = clone && point && clone.source ? cloneSamplePoint(point, Boolean(this.stroke)) : null;
		const offset = clone && point && !this.stroke && !this.optionHeld ? cloneStrokeOffset(point) : null;
		const preview =
			offset && point
				? this.cachedPreview({x: point.x + offset.x, y: point.y + offset.y}, this.stroke?.diameter ?? settings.diameter, settings.hardness)
				: null;
		this.overlay = {
			brushCursor: point
				? {
						x: point.x,
						y: point.y,
						diameter: this.stroke?.diameter ?? settings.diameter,
						...(this.showHardness ? {hardness: settings.hardness} : {}),
						...(sample ? {sample} : {}),
						...(preview ? {preview: {...preview, opacity: settings.opacity}} : {}),
					}
				: null,
			// With a source, the circle, its preview and the crosshair stand in for the cursor.
			// Holding Option to pick a new source brings the crosshair back.
			...(clone?.source && point && !this.optionHeld ? {canvasCursor: 'none' as const} : {}),
		};
	}

	private cachedPreview(center: ToolPoint, diameter: number, hardness: number) {
		const clone = getCloneSettings();
		const layer = this.context.activeLayerId ? this.context.document.layers[this.context.activeLayerId] : undefined;
		const assetId = layer?.content.kind === 'pixel' ? layer.content.assetId : '';
		const key = [Math.round(center.x), Math.round(center.y), diameter, hardness, clone.aligned, clone.sampleAllLayers, assetId].join(':');
		if (key === this.previewKey && this.previewImage) return this.previewImage;
		this.previewKey = key;
		this.previewImage = renderClonePreview({
			document: this.context.document,
			activeLayerId: this.context.activeLayerId,
			center,
			diameter,
			hardness,
		});
		return this.previewImage;
	}
}
