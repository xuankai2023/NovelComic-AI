import {createDocumentCommand} from '../../commands/document-command-types';
import {createTextLayer} from '../../document/defaults';
import {dragBox, roundWhole} from '../../document/selection-geometry';
import type {DocumentState, LayerTransform} from '../../document/types';
import {documentToLayer, invertAffine, layerLocalMatrix, layerWorldMatrix, multiplyAffine, transformPoint} from '../coordinates';
import {shapeInsertionOrder, shapeParentId} from '../shape/shape-geometry';
import {
	fromPlaced,
	isValidPlaced,
	placedCorners,
	placedPoint,
	resizeCursor,
	toPlaced,
} from '../move/transform-math';
import {
	boxIsValid,
	caretIndexAt,
	cloneTextStyle,
	isValidTextStyle,
	layerNameForText,
	measurePointText,
	pinTextOrigin,
	pointTextOrigin,
	sameTextColor,
	styleFromTextContent,
	textContentFromStyle,
	textFits,
	textTooLargeMessage,
	topTextLayerAt,
	type TextStyle,
} from '../type/text-style';
import {
	bindTypeActions,
	clearTypeDraft,
	editTextLayer,
	getTypeDraft,
	nudgeStyle,
	rememberTypeDefaults,
	setTypeDraft,
	setTypeError,
	styleForNewText,
	subscribeTypeEditor,
	takeLiveTextEdit,
	type TextDraft,
} from '../type/type-settings';
import type {ToolCancelReason, ToolKeyEvent, ToolPointerEvent, ToolPoint} from '../types';
import {BaseToolSession} from './base';

const HANDLES = [
	{x: 0, y: 0},
	{x: 0.5, y: 0},
	{x: 1, y: 0},
	{x: 1, y: 0.5},
	{x: 1, y: 1},
	{x: 0.5, y: 1},
	{x: 0, y: 1},
	{x: 0, y: 0.5},
];

const finite = (point: ToolPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

const zoomOf = (viewport: {pointsPerPixel?: number; transform: {zoom: number}}) =>
	viewport.pointsPerPixel || viewport.transform.zoom || 1;

const draftTransform = (draft: TextDraft): LayerTransform => ({
	originX: draft.originX,
	originY: draft.originY,
	width: draft.width,
	height: draft.height,
	rotation: draft.rotation,
	scaleX: draft.scaleX,
	scaleY: draft.scaleY,
	sampling: draft.sampling,
});

const stylesEqual = (left: TextStyle, right: TextStyle) =>
	left.content === right.content &&
	left.fontFamily === right.fontFamily &&
	left.fontSize === right.fontSize &&
	left.align === right.align &&
	left.tracking === right.tracking &&
	left.leading === right.leading &&
	sameTextColor(left.color, right.color) &&
	JSON.stringify(left.boxSize) === JSON.stringify(right.boxSize) &&
	JSON.stringify(left.runs) === JSON.stringify(right.runs);

const transformsEqual = (left: LayerTransform, right: LayerTransform) =>
	left.originX === right.originX &&
	left.originY === right.originY &&
	left.width === right.width &&
	left.height === right.height &&
	left.rotation === right.rotation &&
	left.scaleX === right.scaleX &&
	left.scaleY === right.scaleY &&
	left.sampling === right.sampling;

const draftMatrix = (document: DocumentState, draft: TextDraft) => {
	const local = layerLocalMatrix(draftTransform(draft));
	if (!local) return null;
	if (!draft.layerId) return local;
	const layer = document.layers[draft.layerId];
	if (!layer?.parentId) return local;
	const parent = layerWorldMatrix(document, layer.parentId);
	return parent ? multiplyAffine(parent, local) : local;
};

const localPoint = (document: DocumentState, draft: TextDraft, point: ToolPoint) => {
	const matrix = draftMatrix(document, draft);
	const inverse = matrix && invertAffine(matrix);
	return inverse ? transformPoint(inverse, point) : null;
};

const edgeReach = (draft: TextDraft, zoom: number) => {
	const handle = Math.max(2, 6 / Math.max(0.01, zoom * Math.abs(draft.scaleX || 1)));
	return Math.min((handle * 10) / 6, Math.min(draft.width, draft.height) / 3);
};

const hitHandle = (local: ToolPoint, draft: TextDraft, zoom: number) => {
	const reach = edgeReach(draft, zoom);
	const {x, y} = local;
	if (x < -reach || y < -reach || x > draft.width + reach || y > draft.height + reach) return null;
	const left = x <= reach;
	const right = x >= draft.width - reach;
	const top = y <= reach;
	const bottom = y >= draft.height - reach;
	if (left && top) return 0;
	if (right && top) return 2;
	if (right && bottom) return 4;
	if (left && bottom) return 6;
	if (top) return 1;
	if (right) return 3;
	if (bottom) return 5;
	if (left) return 7;
	return null;
};

const resizeTextDraft = (start: TextDraft, anchor: ToolPoint, point: ToolPoint, handle: number): TextDraft | null => {
	const old = draftTransform(start);
	const placed = toPlaced(old);
	const dx = point.x - anchor.x;
	const dy = point.y - anchor.y;
	const radians = (((old.rotation % 360) + 360) % 360) * (Math.PI / 180);
	const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
	const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
	const unit = HANDLES[handle];
	if (!unit || placed.placedWidth <= 0 || placed.placedHeight <= 0) return null;
	let left = 0;
	let top = 0;
	let right = placed.placedWidth;
	let bottom = placed.placedHeight;
	const minW = (16 * placed.placedWidth) / start.width;
	const minH = (16 * placed.placedHeight) / start.height;
	if (unit.x === 0) left = Math.min(localX, right - minW);
	if (unit.x === 1) right = Math.max(left + minW, right + localX);
	if (unit.y === 0) top = Math.min(localY, bottom - minH);
	if (unit.y === 1) bottom = Math.max(top + minH, bottom + localY);
	const boxW = Math.round(((right - left) * start.width) / placed.placedWidth);
	const boxH = Math.round(((bottom - top) * start.height) / placed.placedHeight);
	if (!boxIsValid({width: boxW, height: boxH})) return null;
	const nextPlaced = {
		...placed,
		contentWidth: boxW,
		contentHeight: boxH,
		placedWidth: boxW * Math.abs(old.scaleX),
		placedHeight: boxH * Math.abs(old.scaleY),
	};
	const pinned = placedPoint(placed, {x: left / placed.placedWidth, y: top / placed.placedHeight});
	const current = placedPoint(nextPlaced, {x: 0, y: 0});
	nextPlaced.originX += pinned.x - current.x;
	nextPlaced.originY += pinned.y - current.y;
	if (!isValidPlaced(nextPlaced)) return null;
	const transform = fromPlaced(nextPlaced);
	const style = {...start.style, boxSize: {width: boxW, height: boxH}};
	return {
		...start,
		style,
		originX: transform.originX,
		originY: transform.originY,
		width: boxW,
		height: boxH,
		rotation: transform.rotation,
		scaleX: transform.scaleX,
		scaleY: transform.scaleY,
		sampling: transform.sampling,
	};
};

/**
 * Type (T), matching TypeTool.swift and InlineTextEditor.
 * A click makes point text. A drag makes a paragraph box. A click on existing
 * text edits that layer instead of making another. Escape throws the draft
 * away. Done, ⌘/Ctrl+Enter, clicking elsewhere, and switching tools commit
 * one history item. An empty new layer commits as nothing.
 */
export class TypeToolSession extends BaseToolSession {
	private unsubscribe: () => void = () => undefined;
	private gesture: 'marquee' | 'resize' | null = null;
	private anchor: ToolPoint | null = null;
	private marquee: {x: number; y: number; width: number; height: number} | null = null;
	private resize: {handle: number; draft: TextDraft; anchor: ToolPoint} | null = null;
	private cursor = 'text';
	private previewKey = '';
	private seenId: string | null = null;

	constructor(context: ConstructorParameters<typeof BaseToolSession>[1]) {
		super('type', context);
		this.unsubscribe = subscribeTypeEditor(() => this.onStore());
		bindTypeActions({
			commit: () => this.commit(),
			cancel: () => this.cancel(),
			nudge: (kind, step) => this.nudge(kind, step),
		});
		const pending = takeLiveTextEdit();
		if (pending) {
			const layer = context.document.layers[pending];
			if (layer?.kind === 'text' && layer.content.kind === 'text' && !layer.locked) this.editLayer(layer, 'end');
		}
	}

	pointerDown(event: ToolPointerEvent) {
		if (event.modifiers.space || (event.buttons & 1) !== 1 || !finite(event.documentPoint)) return;
		const draft = getTypeDraft();
		const zoom = zoomOf(this.context.viewport);
		if (draft) {
			const local = localPoint(this.context.document, draft, event.documentPoint);
			if (local) {
				const handle = hitHandle(local, draft, zoom);
				const reach = edgeReach(draft, zoom);
				const inside =
					local.x >= -reach &&
					local.y >= -reach &&
					local.x <= draft.width + reach &&
					local.y <= draft.height + reach;
				if (inside) {
					if (handle != null) this.startResize(handle, event.documentPoint);
					return;
				}
			}
			if (!this.commit()) return;
		}
		const hit = topTextLayerAt(this.context.document, event.documentPoint);
		if (hit) {
			this.editLayer(hit, event.documentPoint);
			return;
		}
		this.startMarquee(event.documentPoint);
	}

	pointerMove(event: ToolPointerEvent) {
		if (!finite(event.documentPoint)) return;
		if (this.gesture === 'marquee' && this.anchor) {
			this.marquee = dragBox(this.anchor, event.documentPoint, false, false);
			this._status = 'active';
			this.publish();
			this.context.notifyOverlay?.();
			return;
		}
		if (this.gesture === 'resize' && this.resize) {
			const next = resizeTextDraft(this.resize.draft, this.resize.anchor, event.documentPoint, this.resize.handle);
			if (next) setTypeDraft(next, false);
			return;
		}
		const draft = getTypeDraft();
		if (!draft) {
			this.cursor = 'text';
			this.publish();
			return;
		}
		const local = localPoint(this.context.document, draft, event.documentPoint);
		const handle = local ? hitHandle(local, draft, zoomOf(this.context.viewport)) : null;
		this.cursor = handle == null ? 'text' : resizeCursor(handle, placedCorners(toPlaced(draftTransform(draft))));
		this.publish();
		this.context.notifyOverlay?.();
	}

	pointerUp(_event: ToolPointerEvent) {
		void _event;
		if (this.gesture === 'marquee') this.finishMarquee();
		else if (this.gesture === 'resize') this.endResize();
		this.gesture = null;
	}

	pointerCancel(reason: ToolCancelReason) {
		if (this._status === 'disposed') return;
		if ((reason === 'lostpointercapture' || reason === 'pointercancel') && !this.gesture) return;
		if (reason === 'tool-switch') {
			this.gesture = null;
			this.marquee = null;
			this.resize = null;
			this.commit();
			return;
		}
		if (reason === 'escape' || reason === 'unmount' || reason === 'capability') {
			this.cancel();
			return;
		}
		if (this.gesture === 'marquee') this.finishMarquee();
		else if (this.gesture === 'resize') this.endResize();
		this.gesture = null;
	}

	keyDown(event: ToolKeyEvent) {
		if (event.key === 'Enter' && (event.modifiers.meta || event.modifiers.control) && !event.modifiers.alt) {
			this.commit();
			return true;
		}
		if (!event.modifiers.alt || !getTypeDraft()) return false;
		const step = event.modifiers.shift ? 10 : 1;
		if (event.key === 'ArrowLeft') return this.nudge('tracking', -step);
		if (event.key === 'ArrowRight') return this.nudge('tracking', step);
		if (event.key === 'ArrowUp') return this.nudge('leading-up', step);
		if (event.key === 'ArrowDown') return this.nudge('leading-down', step);
		return false;
	}

	dispose() {
		if (this._status === 'disposed') return;
		this.unsubscribe();
		this.unsubscribe = () => undefined;
		if (getTypeDraft()) this.cancel();
		bindTypeActions(null);
		super.dispose();
	}

	private editLayer(layer: NonNullable<ReturnType<typeof topTextLayerAt>>, point: ToolPoint | 'end') {
		let caret: number | 'end' = 'end';
		if (point !== 'end' && layer.content.kind === 'text') {
			const local = documentToLayer(point, this.context.document, layer.id);
			const style = styleFromTextContent(layer.content, layer.transform);
			caret = local ? caretIndexAt(style, layer.transform.width, layer.transform.height, local.x, local.y) : style.content.length;
		}
		if (!editTextLayer(layer, caret)) return;
		this.context.setSelection(layer.id);
		this._status = 'active';
	}

	private startMarquee(point: ToolPoint) {
		this.anchor = {x: roundWhole(point.x), y: roundWhole(point.y)};
		this.marquee = {x: this.anchor.x, y: this.anchor.y, width: 0, height: 0};
		this.gesture = 'marquee';
		this.cursor = 'text';
		this._status = 'active';
		this.publish();
		this.context.notifyOverlay?.();
	}

	private finishMarquee() {
		const rect = this.marquee;
		this.marquee = null;
		this.anchor = null;
		this.gesture = null;
		if (!rect) return;
		if (rect.width < 4 && rect.height < 4) this.beginPoint(rect);
		else this.beginBox(rect);
	}

	private beginPoint(rect: {x: number; y: number}) {
		const style = styleForNewText();
		const placed = pointTextOrigin(rect, style);
		if (!boxIsValid({width: placed.width, height: placed.height})) {
			setTypeError(textTooLargeMessage());
			this.publish();
			return;
		}
		setTypeDraft(blankDraft(style, placed.originX, placed.originY, placed.width, placed.height), true);
		this._status = 'active';
	}

	private beginBox(rect: {x: number; y: number; width: number; height: number}) {
		const width = Math.max(16, Math.round(rect.width));
		const height = Math.max(16, Math.round(rect.height));
		if (!boxIsValid({width, height})) {
			setTypeError(textTooLargeMessage());
			this.publish();
			return;
		}
		const style = {...styleForNewText(), boxSize: {width, height}};
		setTypeDraft(blankDraft(style, rect.x, rect.y, width, height), true);
		this._status = 'active';
	}

	private startResize(handle: number, point: ToolPoint) {
		let draft = getTypeDraft();
		if (!draft) return;
		if (!draft.style.boxSize) {
			draft = {...draft, style: {...draft.style, boxSize: {width: draft.width, height: draft.height}}};
			setTypeDraft(draft, false);
		}
		this.resize = {handle, draft, anchor: point};
		this.gesture = 'resize';
		this._status = 'active';
	}

	private endResize() {
		this.resize = null;
		this.gesture = null;
		const draft = getTypeDraft();
		if (draft) setTypeDraft(draft, true);
	}

	private nudge(kind: 'tracking' | 'leading-up' | 'leading-down', step: number) {
		const draft = getTypeDraft();
		if (!draft) return false;
		const style = cloneTextStyle(draft.style);
		nudgeStyle(style, kind, step);
		const applied = applyNudge(draft, style);
		if (applied) setTypeDraft(applied, false);
		return true;
	}

	private commit() {
		const draft = getTypeDraft();
		this.gesture = null;
		this.marquee = null;
		this.resize = null;
		if (!draft) {
			if (this._status !== 'disposed') this._status = 'idle';
			this.publish();
			return true;
		}
		if (!draft.layerId && draft.style.content.trim() === '') {
			this._status = 'committed';
			clearTypeDraft();
			this.syncPreview();
			this.publish();
			return true;
		}
		if (
			draft.originalStyle &&
			draft.originalTransform &&
			stylesEqual(draft.style, draft.originalStyle) &&
			transformsEqual(draftTransform(draft), draft.originalTransform)
		) {
			this._status = 'committed';
			clearTypeDraft();
			this.syncPreview();
			this.publish();
			return true;
		}
		try {
			if (draft.layerId) this.commitExisting(draft);
			else this.commitNew(draft);
			rememberTypeDefaults(draft.style);
			if (draft.layerId) this.context.setSelection(draft.layerId);
			this._status = 'committed';
			clearTypeDraft();
			this.syncPreview();
			this.publish();
			setTypeError(null);
			return true;
		} catch (error) {
			setTypeError(error instanceof Error ? error.message : '无法保存文字。');
			this._status = 'active';
			return false;
		}
	}

	private commitNew(draft: TextDraft) {
		const content = textContentFromStyle(draft.style);
		const layer = createTextLayer(content.text, layerNameForText(content.text), draft.width, draft.height);
		const parentId = shapeParentId(this.context.document, this.context.activeLayerId);
		layer.parentId = parentId;
		layer.order = shapeInsertionOrder(this.context.document, this.context.activeLayerId, parentId);
		layer.transform = draftTransform(draft);
		layer.content = content;
		this.context.dispatch('layer.create', {layer});
		this.context.setSelection(layer.id);
		draft.layerId = layer.id;
	}

	private commitExisting(draft: TextDraft) {
		const content = textContentFromStyle(draft.style);
		const transform = draftTransform(draft);
		const projectId = this.context.document.projectId;
		const sameContent = draft.originalStyle ? stylesEqual(draft.style, draft.originalStyle) : false;
		const sameTransform = draft.originalTransform ? transformsEqual(transform, draft.originalTransform) : false;
		const {kind: _kind, ...changes} = content;
		void _kind;
		const commands = [
			...(sameContent
				? []
				: [
						createDocumentCommand({
							type: 'text.update',
							projectId,
							payload: {layerId: draft.layerId!, changes: {...changes, runs: content.runs ?? []}},
						}),
					]),
			...(sameTransform
				? []
				: [createDocumentCommand({type: 'layer.transform', projectId, payload: {layerId: draft.layerId!, transform}})]),
		];
		if (commands.length) this.context.dispatchCommands(commands);
	}

	private cancel() {
		this.gesture = null;
		this.marquee = null;
		this.anchor = null;
		this.resize = null;
		this.cursor = 'text';
		if (this._status !== 'disposed') this._status = 'cancelled';
		clearTypeDraft();
		this.syncPreview();
		this.publish();
	}

	private onStore() {
		if (this._status === 'disposed') return;
		const draft = getTypeDraft();
		if (draft && this._status !== 'committed') this._status = 'active';
		if (draft?.layerId && draft.id !== this.seenId) {
			this.seenId = draft.id;
			this.context.setSelection(draft.layerId);
		}
		if (!draft) this.seenId = null;
		this.syncPreview();
		this.publish();
		this.context.notifyOverlay?.();
	}

	private syncPreview() {
		const draft = getTypeDraft();
		if (!draft?.layerId) {
			if (this.previewKey) {
				this.previewKey = '';
				this.context.setMovePreview?.(null);
			}
			return;
		}
		const key = [draft.layerId, draft.originX, draft.originY, draft.width, draft.height, draft.rotation, draft.scaleX, draft.scaleY].join(':');
		if (key === this.previewKey) return;
		this.previewKey = key;
		const source = this.context.document;
		const layer = source.layers[draft.layerId];
		if (!layer) {
			this.context.setMovePreview?.(null);
			return;
		}
		this.context.setMovePreview?.({
			...source,
			layers: {...source.layers, [layer.id]: {...layer, opacity: 0, transform: draftTransform(draft)}},
		});
	}

	private publish() {
		if (this._status === 'disposed') return;
		const draft = getTypeDraft();
		const cursor = this.cursor;
		if (this.marquee && (this.marquee.width > 0 || this.marquee.height > 0)) {
			this.overlay = {canvasCursor: 'text', text: {mode: 'marquee', marquee: this.marquee}};
			return;
		}
		if (draft) {
			this.overlay = {canvasCursor: cursor, text: {mode: 'edit'}};
			return;
		}
		this.overlay = {canvasCursor: 'text'};
	}
}

const applyNudge = (draft: TextDraft, style: TextStyle) => {
	if (!isValidTextStyle(style) || !textFits(style)) return null;
	if (style.boxSize) return {...draft, style, width: style.boxSize.width, height: style.boxSize.height};
	const size = measurePointText(style);
	if (!boxIsValid(size)) return null;
	const before = draftTransform(draft);
	const pinned = pinTextOrigin(before, {...before, width: size.width, height: size.height});
	return {...draft, style, originX: pinned.originX, originY: pinned.originY, width: size.width, height: size.height};
};

const blankDraft = (style: TextStyle, originX: number, originY: number, width: number, height: number): TextDraft => ({
	id: `text-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
	layerId: null,
	originX,
	originY,
	width,
	height,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
	sampling: 'smooth',
	style,
	selectionStart: 0,
	selectionEnd: 0,
	originalStyle: null,
	originalTransform: null,
});
