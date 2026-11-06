import {createDocumentCommand} from '../../commands/document-command-types';
import type {DocumentState, LayerNode, LayerTransform} from '../../document/types';
import {flattenLayerTree} from '../../document/tree';
import {layerToDocument} from '../coordinates';
import type {
	ToolCancelReason,
	ToolKeyEvent,
	ToolOverlayState,
	ToolPointerEvent,
	ToolPoint,
} from '../types';
import {BaseToolSession} from './base';
import {clearLayerWarps, setLayerWarp, type WarpCorners} from '../move/distort-preview';
import {getMoveToolSettings, updateMoveToolSettings} from '../move/move-tool-settings';
import {
	ancestorLocked,
	ancestorVisible,
	cornersUsable,
	documentCornersFor,
	dragCorners,
	dragUpdated,
	followPlaced,
	fromPlaced,
	hitOverlay,
	overlayFromCorners,
	placedCorners,
	placedFromCorners,
	resizeCursor,
	roundPlaced,
	sameLayerTransform,
	selectionBox,
	snapPlacedMove,
	toOriginSpace,
	toPlaced,
	transformPressLayer,
	uprightBox,
	type PlacedTransform,
	type TransformDrag,
	type TransformDragMode,
} from '../move/transform-math';

type EditSet = {
	ids: string[];
	group: boolean;
	uniform: boolean;
	box: PlacedTransform | null;
	members: Record<string, PlacedTransform>;
};

type Gesture = {
	base: DocumentState;
	pointerId: number;
	startDocument: ToolPoint;
	startSpace: ToolPoint;
	mode: TransformDragMode;
	box: PlacedTransform;
	draftBox: PlacedTransform;
	members: Record<string, PlacedTransform>;
	memberIds: string[];
	sourceIds: string[];
	group: boolean;
	uniform: boolean;
	wantsDuplicate: boolean;
	copies: LayerNode[] | null;
	corners: ToolPoint[] | null;
	latest: Record<string, LayerTransform>;
};

const makeId = () =>
	`layer-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

const zoomOf = (viewport: {pointsPerPixel: number; transform: {zoom: number}}) =>
	viewport.pointsPerPixel || viewport.transform.zoom || 1;

const isInside = (document: DocumentState, layerId: string, ancestorId: string) => {
	let parent = document.layers[layerId]?.parentId ?? null;
	while (parent) {
		if (parent === ancestorId) return true;
		parent = document.layers[parent]?.parentId ?? null;
	}
	return false;
};

export class MoveToolSession extends BaseToolSession {
	private selectedIds: string[] = [];
	private gesture: Gesture | null = null;

	constructor(context: ConstructorParameters<typeof BaseToolSession>[1]) {
		super('move', context);
		this.readSelection();
		this.refresh();
	}

	sync() {
		if (this.gesture) return;
		this.readSelection();
		this.refresh();
	}

	pointerDown(event: ToolPointerEvent) {
		super.pointerDown(event);
		this.readSelection();
		const settings = getMoveToolSettings();
		const zoom = zoomOf(this.context.viewport);
		const current = this.describe(this.context.document, this.selectedIds);
		const geometry =
			settings.showControls && current.box
				? overlayFromCorners(this.boxCorners(this.context.document, current), zoom, true)
				: null;
		let mode = geometry ? hitOverlay(geometry, event.documentPoint, zoom) : null;
		if (!mode) {
			const target = transformPressLayer({
				document: this.context.document,
				point: event.documentPoint,
				activeLayerId: this.selectedIds.at(-1) ?? this.context.activeLayerId,
				selectedLayerIds: this.selectedIds,
				autoSelect: settings.autoSelect,
				command: event.modifiers.meta,
				shift: event.modifiers.shift,
			});
			if (!target) {
				this.overlay = {canvasCursor: 'default'};
				return;
			}
			if (target.picked && event.modifiers.meta && event.modifiers.shift)
				this.extendSelection(target.id);
			else if (target.picked) this.replaceSelection([target.id]);
			mode = {kind: 'move'};
		}
		const edit = this.describe(this.context.document, this.selectedIds);
		if (!edit.box || !edit.ids.length) {
			this.overlay = {canvasCursor: 'default'};
			return;
		}
		let corners: ToolPoint[] | null = null;
		if (mode.kind === 'resize' && event.modifiers.meta && !edit.group) {
			mode = {kind: 'distort', index: mode.index};
			corners = placedCorners(edit.box);
		}
		const layer = this.context.document.layers[edit.ids[0] ?? ''];
		const startSpace =
			edit.group || !layer
				? event.documentPoint
				: toOriginSpace(this.context.document, layer, event.documentPoint);
		this.gesture = {
			base: structuredClone(this.context.document),
			pointerId: event.pointerId,
			startDocument: event.documentPoint,
			startSpace,
			mode,
			box: edit.box,
			draftBox: edit.box,
			members: edit.members,
			memberIds: [...edit.ids],
			sourceIds: [...edit.ids],
			group: edit.group,
			uniform: edit.uniform,
			wantsDuplicate: mode.kind === 'move' && event.modifiers.alt,
			copies: null,
			corners,
			latest: Object.fromEntries(
				edit.ids.flatMap((id) => {
					const transform = this.context.document.layers[id]?.transform;
					return transform ? [[id, transform]] : [];
				}),
			),
		};
		this.paint(this.gesture.base, this.gesture.latest, [], this.dragCursor(event));
	}

	pointerMove(event: ToolPointerEvent) {
		if (!this.gesture) {
			this.readSelection();
			this.paintHover(event);
			return;
		}
		const gesture = this.gesture;
		const settings = getMoveToolSettings();
		const zoom = zoomOf(this.context.viewport);
		const distance = Math.hypot(
			event.documentPoint.x - gesture.startDocument.x,
			event.documentPoint.y - gesture.startDocument.y,
		);
		if (gesture.wantsDuplicate && !gesture.copies && distance >= 1) this.duplicate(gesture);
		if (distance < 0.5) {
			this.publish(gesture, gesture.latest, null, []);
			return;
		}
		const layer = gesture.base.layers[gesture.sourceIds[0] ?? ''];
		const point =
			gesture.group || !layer
				? event.documentPoint
				: toOriginSpace(gesture.base, layer, event.documentPoint);
		const drag: TransformDrag = {
			original: gesture.box,
			start: gesture.startSpace,
			mode: gesture.mode,
			originalCorners: gesture.corners,
		};
		let placed = gesture.box;
		let warp: ToolPoint[] | null = null;
		let guides: NonNullable<ToolOverlayState['snapGuides']> = [];
		if (gesture.mode.kind === 'distort' && gesture.corners) {
			const moved = dragCorners(drag, point, event.modifiers.shift);
			if (moved && cornersUsable(moved)) {
				warp = moved;
				placed = placedFromCorners(gesture.box, moved);
			}
		} else {
			placed = dragUpdated(
				drag,
				point,
				settings.lockRatio,
				event.modifiers.shift,
				event.modifiers.alt && gesture.mode.kind === 'resize',
			);
			const upright = Math.abs(placed.rotation % 180) < 0.001;
			if (
				!event.modifiers.control &&
				(gesture.mode.kind === 'move' || (gesture.mode.kind === 'resize' && upright))
			) {
				const snapped = snapPlacedMove(
					gesture.base,
					placed,
					gesture.copies ? [] : gesture.sourceIds,
					zoom,
				);
				placed = snapped.placed;
				guides = snapped.guides;
			}
		}
		placed = roundPlaced(placed);
		if (!isFinitePlaced(placed)) placed = gesture.box;
		gesture.draftBox = placed;
		const transforms = this.drafts(gesture, placed, event.documentPoint);
		gesture.latest = transforms;
		this.publish(gesture, transforms, warp, guides);
	}

	pointerUp(event: ToolPointerEvent) {
		if (this.gesture) this.pointerMove(event);
		this.finish(this.gesture, true);
		super.pointerUp(event);
	}

	pointerCancel(reason: ToolCancelReason) {
		this.finish(reason === 'tool-switch' ? this.gesture : null, reason === 'tool-switch');
		super.pointerCancel(reason);
	}

	keyDown(event: ToolKeyEvent) {
		if (
			event.key.toLowerCase() === 'h' &&
			(event.modifiers.meta || event.modifiers.control) &&
			!event.modifiers.alt &&
			!event.modifiers.shift
		) {
			updateMoveToolSettings({showControls: !getMoveToolSettings().showControls});
			this.refresh();
			return true;
		}
		return false;
	}

	private finish(gesture: Gesture | null, commit: boolean) {
		const hadGesture = this.gesture !== null;
		if (commit && gesture) this.commit(gesture);
		this.gesture = null;
		if (hadGesture) {
			clearLayerWarps();
			this.context.setMovePreview?.(null);
		}
		this.refresh();
	}

	private readSelection() {
		this.selectedIds = [...this.context.selectedLayerIds];
	}

	private replaceSelection(ids: string[]) {
		this.selectedIds = ids;
		if (this.context.setSelectedIds) this.context.setSelectedIds(ids);
		else if (!ids.length) this.context.clearSelection();
		else ids.forEach((id, index) => this.context.setSelection(id, index > 0));
	}

	private extendSelection(id: string) {
		if (this.selectedIds.includes(id) && this.selectedIds.length > 1)
			this.replaceSelection(this.selectedIds.filter((item) => item !== id));
		else if (!this.selectedIds.includes(id))
			this.replaceSelection([...this.selectedIds, id]);
	}

	private describe(document: DocumentState, ids: readonly string[]): EditSet {
		const selected = new Set(ids);
		const roots = ids.filter((id) => {
			const layer = document.layers[id];
			if (!layer || !ancestorVisible(document, layer) || ancestorLocked(document, layer))
				return false;
			let parent = layer.parentId;
			while (parent) {
				if (selected.has(parent)) return false;
				parent = document.layers[parent]?.parentId ?? null;
			}
			return true;
		});
		let memberIds = roots;
		if (roots.length === 1 && document.layers[roots[0] ?? '']?.kind === 'group') {
			const groupId = roots[0] ?? '';
			memberIds = flattenLayerTree(document)
				.filter(
					(layer) =>
						layer.kind !== 'group' &&
						ancestorVisible(document, layer) &&
						!ancestorLocked(document, layer) &&
						isInside(document, layer.id, groupId),
				)
				.map((layer) => layer.id);
		}
		memberIds = memberIds.filter((id) => document.layers[id]?.kind !== 'group');
		const members = Object.fromEntries(
			memberIds.flatMap((id) => {
				const layer = document.layers[id];
				return layer ? [[id, toPlaced(layer.transform)]] : [];
			}),
		);
		const group = memberIds.length > 1;
		const uniform = memberIds.every((id) => !document.layers[id]?.parentId);
		const box = group
			? uprightBox(Object.values(members))
			: (Object.values(members)[0] ?? null);
		return {ids: memberIds, group, uniform, box, members};
	}

	private boxCorners(document: DocumentState, edit: EditSet): ToolPoint[] {
		if (!edit.box) return [];
		if (!edit.group) return documentCornersFor(document, edit.ids[0] ?? '');
		if (edit.uniform) return placedCorners(edit.box);
		const bounds = selectionBox(document, edit.ids);
		if (!bounds) return placedCorners(edit.box);
		return [
			{x: bounds.left, y: bounds.top},
			{x: bounds.right, y: bounds.top},
			{x: bounds.right, y: bounds.bottom},
			{x: bounds.left, y: bounds.bottom},
		];
	}

	private duplicate(gesture: Gesture) {
		const copies = gesture.sourceIds.flatMap((id) => {
			const source = gesture.base.layers[id];
			if (!source) return [];
			const copy: LayerNode = structuredClone(source);
			copy.id = makeId();
			copy.name = `${source.name} copy`;
			copy.order = source.order + 1;
			return [copy];
		});
		if (!copies.length) return;
		gesture.copies = copies;
		gesture.memberIds = copies.map((copy) => copy.id);
		gesture.members = Object.fromEntries(
			copies.flatMap((copy, index) => {
				const placed = gesture.members[gesture.sourceIds[index] ?? ''];
				return placed ? [[copy.id, placed]] : [];
			}),
		);
		gesture.latest = Object.fromEntries(
			copies.map((copy) => [copy.id, copy.transform]),
		);
		this.replaceSelection(gesture.memberIds);
	}

	private drafts(
		gesture: Gesture,
		placed: PlacedTransform,
		documentPoint: ToolPoint,
	): Record<string, LayerTransform> {
		const transforms: Record<string, LayerTransform> = {};
		if (!gesture.group) {
			const id = gesture.memberIds[0];
			const original = id ? gesture.members[id] : undefined;
			if (id && original)
				transforms[id] = fromPlaced({
					...placed,
					contentWidth: original.contentWidth,
					contentHeight: original.contentHeight,
					sampling: original.sampling,
				});
			return transforms;
		}
		for (const [index, id] of gesture.memberIds.entries()) {
			const original = gesture.members[id];
			const source = gesture.base.layers[gesture.sourceIds[index] ?? ''];
			if (!original || !source) continue;
			if (!gesture.uniform || source.parentId) {
				if (gesture.mode.kind !== 'move') {
					transforms[id] = fromPlaced(original);
					continue;
				}
				const start = toOriginSpace(gesture.base, source, gesture.startDocument);
				const current = toOriginSpace(gesture.base, source, documentPoint);
				transforms[id] = fromPlaced({
					...original,
					originX: original.originX + (current.x - start.x),
					originY: original.originY + (current.y - start.y),
				});
			} else transforms[id] = fromPlaced(followPlaced(original, gesture.box, placed));
		}
		return transforms;
	}

	private previewDocument(
		gesture: Gesture,
		transforms: Record<string, LayerTransform>,
	): DocumentState {
		const next = structuredClone(gesture.base);
		for (const copy of gesture.copies ?? []) {
			next.layers[copy.id] = {
				...copy,
				transform: transforms[copy.id] ?? copy.transform,
			};
			if (copy.parentId === null && !next.rootLayerIds.includes(copy.id))
				next.rootLayerIds = [...next.rootLayerIds, copy.id];
		}
		for (const [id, transform] of Object.entries(transforms)) {
			const layer = next.layers[id];
			if (layer) next.layers[id] = {...layer, transform};
		}
		return next;
	}

	private publish(
		gesture: Gesture,
		transforms: Record<string, LayerTransform>,
		warp: ToolPoint[] | null,
		guides: NonNullable<ToolOverlayState['snapGuides']>,
	) {
		clearLayerWarps();
		const preview = this.previewDocument(gesture, transforms);
		if (warp && warp.length === 4 && gesture.mode.kind === 'distort') {
			const id = gesture.memberIds[0];
			const source = gesture.base.layers[gesture.sourceIds[0] ?? ''];
			if (id && source) {
				const corners = warp.map((corner) =>
					source.parentId
						? (layerToDocument(corner, gesture.base, source.parentId) ?? corner)
						: corner,
				) as WarpCorners;
				setLayerWarp(id, corners);
			}
		}
		this.context.setMovePreview?.(preview);
		this.paint(preview, transforms, guides, this.dragCursor(), warp, gesture.draftBox);
	}

	private commit(gesture: Gesture) {
		const transactionId = `transform-${gesture.pointerId}`;
		const commands = [];
		const copied = new Set((gesture.copies ?? []).map((copy) => copy.id));
		for (const copy of gesture.copies ?? []) {
			commands.push(
				createDocumentCommand({
					type: 'layer.create',
					projectId: gesture.base.projectId,
					payload: {
						layer: {...copy, transform: gesture.latest[copy.id] ?? copy.transform},
					},
					transactionId,
				}),
			);
		}
		for (const [id, transform] of Object.entries(gesture.latest)) {
			if (copied.has(id)) continue;
			const current = gesture.base.layers[id]?.transform;
			if (!current || sameLayerTransform(current, transform)) continue;
			commands.push(
				createDocumentCommand({
					type: 'layer.transform',
					projectId: gesture.base.projectId,
					payload: {layerId: id, transform},
					transactionId,
				}),
			);
		}
		if (commands.length) this.context.dispatchCommands(commands);
	}

	private paint(
		document: DocumentState,
		transforms: Record<string, LayerTransform>,
		guides: NonNullable<ToolOverlayState['snapGuides']>,
		cursor: string,
		warp: ToolPoint[] | null = null,
		draftBox: PlacedTransform | null = null,
	) {
		const settings = getMoveToolSettings();
		if (!settings.showControls && !warp) {
			this.overlay = {canvasCursor: cursor, snapGuides: guides};
			return;
		}
		const zoom = zoomOf(this.context.viewport);
		let corners = warp;
		const gesture = this.gesture;
		if (!corners && gesture && !gesture.group) {
			const id = gesture.memberIds[0];
			const transform = id ? (transforms[id] ?? document.layers[id]?.transform) : undefined;
			if (id && transform) corners = documentCornersFor(document, id, transform);
		} else if (!corners && gesture?.group && gesture.uniform && draftBox) {
			corners = placedCorners(draftBox);
		}
		if (!corners?.length) {
			const edit = this.describe(document, this.selectedIds);
			corners = this.boxCorners(document, edit);
		}
		if (!corners.length) {
			this.overlay = {canvasCursor: cursor, snapGuides: guides};
			return;
		}
		this.overlay = {
			transform: overlayFromCorners(corners, zoom, !warp),
			snapGuides: guides,
			canvasCursor: cursor,
		};
	}

	private paintHover(event: ToolPointerEvent) {
		const settings = getMoveToolSettings();
		const zoom = zoomOf(this.context.viewport);
		const edit = this.describe(this.context.document, this.selectedIds);
		const geometry =
			settings.showControls && edit.box
				? overlayFromCorners(this.boxCorners(this.context.document, edit), zoom, true)
				: null;
		const hit = geometry ? hitOverlay(geometry, event.documentPoint, zoom) : null;
		const target = transformPressLayer({
			document: this.context.document,
			point: event.documentPoint,
			activeLayerId: this.selectedIds.at(-1) ?? null,
			selectedLayerIds: this.selectedIds,
			autoSelect: settings.autoSelect,
			command: event.modifiers.meta,
			shift: event.modifiers.shift,
		});
		let cursor = 'default';
		if (hit?.kind === 'rotate') cursor = 'crosshair';
		else if (hit?.kind === 'resize')
			cursor = resizeCursor(hit.index, geometry?.corners ?? []);
		else if (target) cursor = event.modifiers.alt ? 'copy' : 'move';
		this.paint(this.context.document, {}, [], cursor);
	}

	private refresh() {
		this.paint(this.context.document, {}, [], 'default');
	}

	private dragCursor(event?: ToolPointerEvent) {
		const mode = this.gesture?.mode;
		if (!mode) return 'move';
		if (mode.kind === 'rotate' || mode.kind === 'distort') return 'crosshair';
		if (mode.kind === 'resize')
			return resizeCursor(mode.index, this.gesture ? placedCorners(this.gesture.draftBox) : []);
		if (this.gesture?.wantsDuplicate || event?.modifiers.alt) return 'copy';
		return 'grabbing';
	}
}

const isFinitePlaced = (placed: PlacedTransform) =>
	[placed.originX, placed.originY, placed.placedWidth, placed.placedHeight, placed.rotation].every(
		Number.isFinite,
	);
