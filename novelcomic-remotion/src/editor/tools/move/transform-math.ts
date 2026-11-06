import type {DocumentState, LayerNode, LayerTransform} from '../../document/types';
import {getTransformBounds} from '../../document/transform';
import {flattenLayerTree} from '../../document/tree';
import {documentToLayer, layerToDocument} from '../coordinates';
import type {ToolPoint} from '../types';

/** Placed box matching Compositor's LayerTransform: origin is the unrotated
 * top-left, rotation is clockwise around the center, and flips stay inside
 * the box. Content width/height stay on the layer so scale can round-trip. */
export type PlacedTransform = {
	originX: number;
	originY: number;
	contentWidth: number;
	contentHeight: number;
	placedWidth: number;
	placedHeight: number;
	rotation: number;
	flipX: boolean;
	flipY: boolean;
	sampling: LayerTransform['sampling'];
};

export type TransformDragMode =
	| {kind: 'move'}
	| {kind: 'resize'; index: number}
	| {kind: 'rotate'}
	| {kind: 'distort'; index: number};

const HANDLES: ToolPoint[] = [
	{x: 0, y: 0},
	{x: 0.5, y: 0},
	{x: 1, y: 0},
	{x: 1, y: 0.5},
	{x: 1, y: 1},
	{x: 0.5, y: 1},
	{x: 0, y: 1},
	{x: 0, y: 0.5},
];

const HANDLE_KINDS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

export const SNAP_SCREEN_PX = 10;
export const ROTATION_HANDLE_PX = 28;

const finite = (value: number) => Number.isFinite(value);

export const toPlaced = (transform: LayerTransform): PlacedTransform => ({
	originX: transform.originX,
	originY: transform.originY,
	contentWidth: transform.width,
	contentHeight: transform.height,
	placedWidth: Math.abs(transform.width * transform.scaleX),
	placedHeight: Math.abs(transform.height * transform.scaleY),
	rotation: transform.rotation,
	flipX: transform.scaleX < 0,
	flipY: transform.scaleY < 0,
	sampling: transform.sampling,
});

export const fromPlaced = (placed: PlacedTransform): LayerTransform => ({
	originX: placed.originX,
	originY: placed.originY,
	width: placed.contentWidth,
	height: placed.contentHeight,
	rotation: placed.rotation,
	scaleX:
		(placed.flipX ? -1 : 1) *
		(placed.placedWidth / Math.max(placed.contentWidth, 0.0001)),
	scaleY:
		(placed.flipY ? -1 : 1) *
		(placed.placedHeight / Math.max(placed.contentHeight, 0.0001)),
	sampling: placed.sampling,
});

export const isValidPlaced = (placed: PlacedTransform) =>
	[
		placed.originX,
		placed.originY,
		placed.placedWidth,
		placed.placedHeight,
		placed.rotation,
		placed.contentWidth,
		placed.contentHeight,
	].every(finite) &&
	placed.placedWidth >= 1 &&
	placed.placedWidth <= 300_000 &&
	placed.placedHeight >= 1 &&
	placed.placedHeight <= 300_000 &&
	Math.abs(placed.originX) <= 1_000_000 &&
	Math.abs(placed.originY) <= 1_000_000 &&
	placed.contentWidth > 0 &&
	placed.contentHeight > 0;

const radiansOf = (rotation: number) =>
	(((rotation % 360) + 360) % 360) * (Math.PI / 180);

export const placedCenter = (placed: PlacedTransform): ToolPoint => ({
	x: placed.originX + placed.placedWidth / 2,
	y: placed.originY + placed.placedHeight / 2,
});

/** Unit square (0…1, y down) mapped onto the placed box, rotated about its center. */
export const placedPoint = (placed: PlacedTransform, unit: ToolPoint): ToolPoint => {
	const x = (unit.x - 0.5) * placed.placedWidth;
	const y = (unit.y - 0.5) * placed.placedHeight;
	const radians = radiansOf(placed.rotation);
	const center = placedCenter(placed);
	return {
		x: center.x + x * Math.cos(radians) - y * Math.sin(radians),
		y: center.y + x * Math.sin(radians) + y * Math.cos(radians),
	};
};

export const placedContains = (placed: PlacedTransform, point: ToolPoint) => {
	const center = placedCenter(placed);
	const x = point.x - center.x;
	const y = point.y - center.y;
	const radians = radiansOf(placed.rotation);
	const localX = x * Math.cos(radians) + y * Math.sin(radians);
	const localY = -x * Math.sin(radians) + y * Math.cos(radians);
	return (
		Math.abs(localX) <= placed.placedWidth / 2 + 0.001 &&
		Math.abs(localY) <= placed.placedHeight / 2 + 0.001
	);
};

export const placedCorners = (placed: PlacedTransform): ToolPoint[] => [
	placedPoint(placed, {x: 0, y: 0}),
	placedPoint(placed, {x: 1, y: 0}),
	placedPoint(placed, {x: 1, y: 1}),
	placedPoint(placed, {x: 0, y: 1}),
];

export const roundPlaced = (placed: PlacedTransform): PlacedTransform => ({
	...placed,
	originX: Math.round(placed.originX),
	originY: Math.round(placed.originY),
	placedWidth: Math.max(1, Math.round(placed.placedWidth)),
	placedHeight: Math.max(1, Math.round(placed.placedHeight)),
	rotation: Math.round(placed.rotation),
});

export const scalePlaced = (
	placed: PlacedTransform,
	percent: number,
	pixelSize: {width: number; height: number},
): PlacedTransform => {
	const placedWidth = Math.max(1, (pixelSize.width * percent) / 100);
	const placedHeight = Math.max(1, (pixelSize.height * percent) / 100);
	const center = placedCenter(placed);
	return {
		...placed,
		placedWidth,
		placedHeight,
		originX: center.x - placedWidth / 2,
		originY: center.y - placedHeight / 2,
	};
};

export const scalePercent = (
	placed: PlacedTransform,
	pixelSize: {width: number; height: number},
) => (placed.placedWidth / Math.max(1, pixelSize.width)) * 100;

/** Carry `member` as the box moves from `from` to `to`. A plain move is an exact origin delta. */
export const followPlaced = (
	member: PlacedTransform,
	from: PlacedTransform,
	to: PlacedTransform,
): PlacedTransform => {
	if (
		from.placedWidth === to.placedWidth &&
		from.placedHeight === to.placedHeight &&
		from.rotation === to.rotation &&
		from.flipX === to.flipX &&
		from.flipY === to.flipY
	) {
		return {
			...member,
			originX: member.originX + (to.originX - from.originX),
			originY: member.originY + (to.originY - from.originY),
		};
	}
	const fromMap = unitMatrix(from);
	const toMap = unitMatrix(to);
	const memberMap = unitMatrix(member);
	const inverse = invert(fromMap);
	if (!inverse) return member;
	return placing(member, multiply(toMap, multiply(inverse, memberMap)));
};

const unitMatrix = (placed: PlacedTransform) => {
	const radians = radiansOf(placed.rotation);
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const center = placedCenter(placed);
	return {
		a: placed.placedWidth * cos,
		b: placed.placedWidth * sin,
		c: -placed.placedHeight * sin,
		d: placed.placedHeight * cos,
		e: center.x - (placed.placedWidth * cos) / 2 + (placed.placedHeight * sin) / 2,
		f: center.y - (placed.placedWidth * sin) / 2 - (placed.placedHeight * cos) / 2,
	};
};

const multiply = (
	left: {a: number; b: number; c: number; d: number; e: number; f: number},
	right: {a: number; b: number; c: number; d: number; e: number; f: number},
) => ({
	a: left.a * right.a + left.c * right.b,
	b: left.b * right.a + left.d * right.b,
	c: left.a * right.c + left.c * right.d,
	d: left.b * right.c + left.d * right.d,
	e: left.a * right.e + left.c * right.f + left.e,
	f: left.b * right.e + left.d * right.f + left.f,
});

const invert = (matrix: {a: number; b: number; c: number; d: number; e: number; f: number}) => {
	const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
	if (!finite(determinant) || Math.abs(determinant) < 1e-12) return null;
	return {
		a: matrix.d / determinant,
		b: -matrix.b / determinant,
		c: -matrix.c / determinant,
		d: matrix.a / determinant,
		e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
		f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
	};
};

const placing = (
	base: PlacedTransform,
	map: {a: number; b: number; c: number; d: number; e: number; f: number},
): PlacedTransform => {
	const sign = base.flipX ? -1 : 1;
	const angle = Math.atan2(map.b * sign, map.a * sign);
	const along = -map.c * Math.sin(angle) + map.d * Math.cos(angle);
	const middle = {
		x: map.a * 0.5 + map.c * 0.5 + map.e,
		y: map.b * 0.5 + map.d * 0.5 + map.f,
	};
	const placedWidth = Math.hypot(map.a, map.b);
	const placedHeight = Math.abs(along);
	const degrees = (angle * 180) / Math.PI;
	const rotation = degrees + Math.round((base.rotation - degrees) / 360) * 360;
	return {
		...base,
		placedWidth,
		placedHeight,
		rotation,
		flipY: along < 0,
		originX: middle.x - placedWidth / 2,
		originY: middle.y - placedHeight / 2,
	};
};

export const uprightBox = (layers: readonly PlacedTransform[]): PlacedTransform | null => {
	const corners = layers.flatMap((layer) => [
		placedPoint(layer, {x: 0, y: 0}),
		placedPoint(layer, {x: 1, y: 0}),
		placedPoint(layer, {x: 1, y: 1}),
		placedPoint(layer, {x: 0, y: 1}),
	]);
	if (!corners.length) return null;
	const minX = Math.min(...corners.map((corner) => corner.x));
	const minY = Math.min(...corners.map((corner) => corner.y));
	const maxX = Math.max(...corners.map((corner) => corner.x));
	const maxY = Math.max(...corners.map((corner) => corner.y));
	const placedWidth = Math.max(1, maxX - minX);
	const placedHeight = Math.max(1, maxY - minY);
	return {
		originX: minX,
		originY: minY,
		contentWidth: placedWidth,
		contentHeight: placedHeight,
		placedWidth,
		placedHeight,
		rotation: 0,
		flipX: false,
		flipY: false,
		sampling: 'smooth',
	};
};

export type TransformDrag = {
	original: PlacedTransform;
	start: ToolPoint;
	mode: TransformDragMode;
	originalCorners: ToolPoint[] | null;
};

export const dragUpdated = (
	drag: TransformDrag,
	point: ToolPoint,
	lockRatio: boolean,
	shift: boolean,
	option: boolean,
): PlacedTransform => {
	let result = {...drag.original};
	if (drag.mode.kind === 'distort') return drag.original;
	if (drag.mode.kind === 'move') {
		let dx = point.x - drag.start.x;
		let dy = point.y - drag.start.y;
		if (shift) {
			if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
			else dx = 0;
		}
		result.originX += dx;
		result.originY += dy;
	} else if (drag.mode.kind === 'rotate') {
		const center = placedCenter(drag.original);
		const delta =
			Math.atan2(point.y - center.y, point.x - center.x) -
			Math.atan2(drag.start.y - center.y, drag.start.x - center.x);
		result.rotation += (delta * 180) / Math.PI;
		if (shift) result.rotation = Math.round(result.rotation / 15) * 15;
	} else {
		const handle = HANDLES[drag.mode.index] ?? HANDLES[0];
		const anchorUnit = option
			? {x: 0.5, y: 0.5}
			: {x: 1 - handle.x, y: 1 - handle.y};
		const anchor = placedPoint(drag.original, anchorUnit);
		const initialHandle = placedPoint(drag.original, handle);
		const dx = initialHandle.x + point.x - drag.start.x - anchor.x;
		const dy = initialHandle.y + point.y - drag.start.y - anchor.y;
		const span = option ? 2 : 1;
		const radians = radiansOf(drag.original.rotation);
		const localX = (dx * Math.cos(radians) + dy * Math.sin(radians)) * span;
		const localY = (-dx * Math.sin(radians) + dy * Math.cos(radians)) * span;
		const sx = handle.x * 2 - 1;
		const sy = handle.y * 2 - 1;
		const rawWidth = sx === 0 ? drag.original.placedWidth : localX * sx;
		const rawHeight = sy === 0 ? drag.original.placedHeight : localY * sy;
		const mirroredX = rawWidth < 0;
		const mirroredY = rawHeight < 0;
		let width = Math.max(1, Math.abs(rawWidth));
		let height = Math.max(1, Math.abs(rawHeight));
		if (lockRatio !== shift) {
			let factor: number;
			if (sx === 0) factor = height / drag.original.placedHeight;
			else if (sy === 0) factor = width / drag.original.placedWidth;
			else {
				factor = Math.max(
					1 / Math.min(drag.original.placedWidth, drag.original.placedHeight),
					(localX * sx * drag.original.placedWidth +
						localY * sy * drag.original.placedHeight) /
						(drag.original.placedWidth * drag.original.placedWidth +
							drag.original.placedHeight * drag.original.placedHeight),
				);
			}
			width = drag.original.placedWidth * factor;
			height = drag.original.placedHeight * factor;
		}
		result.placedWidth = width;
		result.placedHeight = height;
		if (mirroredX) result.flipX = !result.flipX;
		if (mirroredY) result.flipY = !result.flipY;
		const offsetX = (0.5 - anchorUnit.x) * width * (mirroredX ? -1 : 1);
		const offsetY = (0.5 - anchorUnit.y) * height * (mirroredY ? -1 : 1);
		const center = {
			x: anchor.x + offsetX * Math.cos(radians) - offsetY * Math.sin(radians),
			y: anchor.y + offsetX * Math.sin(radians) + offsetY * Math.cos(radians),
		};
		result.originX = center.x - width / 2;
		result.originY = center.y - height / 2;
	}
	return isValidPlaced(result) ? result : drag.original;
};

export const dragCorners = (
	drag: TransformDrag,
	point: ToolPoint,
	shift: boolean,
): ToolPoint[] | null => {
	if (!drag.originalCorners) return null;
	let dx = point.x - drag.start.x;
	let dy = point.y - drag.start.y;
	if (shift) {
		if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
		else dx = 0;
	}
	const result = drag.originalCorners.map((corner) => ({...corner}));
	let moved: number[] = [];
	if (drag.mode.kind === 'distort') {
		const index = drag.mode.index;
		moved = index % 2 === 0 ? [index / 2] : [Math.floor(index / 2), (Math.floor(index / 2) + 1) % 4];
	} else if (drag.mode.kind === 'move') moved = [0, 1, 2, 3];
	else return null;
	for (const corner of moved) {
		result[corner].x += dx;
		result[corner].y += dy;
	}
	return result;
};

export const cornersUsable = (corners: readonly ToolPoint[]) => {
	if (corners.length !== 4 || !corners.every((corner) => finite(corner.x) && finite(corner.y) && Math.abs(corner.x) <= 1_000_000 && Math.abs(corner.y) <= 1_000_000))
		return false;
	const area = (a: ToolPoint, b: ToolPoint, c: ToolPoint) =>
		(b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	return (
		Math.abs(area(corners[0], corners[1], corners[2])) > 0.01 &&
		Math.abs(area(corners[0], corners[2], corners[3])) > 0.01
	);
};

/** Fit a rigid placed box to a free quad. Shear is dropped; the center, average edge lengths, and average edge angle remain. */
export const placedFromCorners = (
	base: PlacedTransform,
	corners: readonly ToolPoint[],
): PlacedTransform => {
	const [tl, tr, br, bl] = corners;
	if (!tl || !tr || !br || !bl) return base;
	const top = Math.hypot(tr.x - tl.x, tr.y - tl.y);
	const bottom = Math.hypot(br.x - bl.x, br.y - bl.y);
	const left = Math.hypot(bl.x - tl.x, bl.y - tl.y);
	const right = Math.hypot(br.x - tr.x, br.y - tr.y);
	const placedWidth = Math.max(1, (top + bottom) / 2);
	const placedHeight = Math.max(1, (left + right) / 2);
	const angle = Math.atan2(tr.y - tl.y + (br.y - bl.y), tr.x - tl.x + (br.x - bl.x));
	const degrees = (angle * 180) / Math.PI;
	const rotation = degrees + Math.round((base.rotation - degrees) / 360) * 360;
	const cx = (tl.x + tr.x + br.x + bl.x) / 4;
	const cy = (tl.y + tr.y + br.y + bl.y) / 4;
	const next = {
		...base,
		placedWidth,
		placedHeight,
		rotation,
		originX: cx - placedWidth / 2,
		originY: cy - placedHeight / 2,
	};
	return isValidPlaced(next) ? next : base;
};

export type TransformOverlayGeometry = {
	corners: ToolPoint[];
	handles: Array<{kind: string; point: ToolPoint}>;
	rotationHandle?: ToolPoint;
};

const mid = (a: ToolPoint, b: ToolPoint): ToolPoint => ({
	x: (a.x + b.x) / 2,
	y: (a.y + b.y) / 2,
});

export const overlayFromCorners = (
	corners: readonly ToolPoint[],
	zoom: number,
	showRotation: boolean,
): TransformOverlayGeometry => {
	const tl = corners[0] ?? {x: 0, y: 0};
	const tr = corners[1] ?? tl;
	const br = corners[2] ?? tr;
	const bl = corners[3] ?? tl;
	const handles = [tl, mid(tl, tr), tr, mid(tr, br), br, mid(br, bl), bl, mid(bl, tl)];
	const geometry: TransformOverlayGeometry = {
		corners: [tl, tr, br, bl],
		handles: handles.map((point, index) => ({
			kind: HANDLE_KINDS[index] ?? 'n',
			point,
		})),
	};
	if (showRotation) {
		const top = handles[1];
		const center = {
			x: (tl.x + tr.x + br.x + bl.x) / 4,
			y: (tl.y + tr.y + br.y + bl.y) / 4,
		};
		const nx = top.x - center.x;
		const ny = top.y - center.y;
		const length = Math.hypot(nx, ny) || 1;
		const distance = ROTATION_HANDLE_PX / Math.max(zoom, 0.0001);
		geometry.rotationHandle = {
			x: top.x + (nx / length) * distance,
			y: top.y + (ny / length) * distance,
		};
	}
	return geometry;
};

export const hitOverlay = (
	geometry: TransformOverlayGeometry,
	point: ToolPoint,
	zoom: number,
): TransformDragMode | null => {
	const tolerance = SNAP_SCREEN_PX / Math.max(zoom, 0.0001);
	const near = (other: ToolPoint) =>
		Math.hypot(point.x - other.x, point.y - other.y) <= tolerance;
	if (geometry.rotationHandle && near(geometry.rotationHandle)) return {kind: 'rotate'};
	const handleIndex = geometry.handles.findIndex((handle) => near(handle.point));
	if (handleIndex >= 0) return {kind: 'resize', index: handleIndex};
	const edges: Array<[number, number, number]> = [
		[0, 2, 1],
		[2, 4, 3],
		[4, 6, 5],
		[6, 0, 7],
	];
	for (const [start, end, handle] of edges) {
		const a = geometry.handles[start]?.point;
		const b = geometry.handles[end]?.point;
		if (!a || !b) continue;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const lengthSquared = dx * dx + dy * dy;
		if (lengthSquared <= 0) continue;
		const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
		if (
			t >= 0 &&
			t <= 1 &&
			Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= tolerance
		)
			return {kind: 'resize', index: handle};
	}
	return null;
};

export const resizeCursor = (index: number, corners: readonly ToolPoint[]) => {
	const tl = corners[0];
	const tr = corners[1];
	if (!tl || !tr) return 'nwse-resize';
	const angle = Math.atan2(tr.y - tl.y, tr.x - tl.x);
	const offsets = [
		Math.PI / 4,
		Math.PI / 2,
		(3 * Math.PI) / 4,
		0,
		Math.PI / 4,
		Math.PI / 2,
		(3 * Math.PI) / 4,
		0,
	];
	const direction =
		(Math.round((angle + (offsets[index] ?? 0)) / (Math.PI / 4)) % 4 + 4) % 4;
	return (['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const)[direction];
};

export const ancestorVisible = (document: DocumentState, layer: LayerNode) => {
	let parentId = layer.parentId;
	while (parentId) {
		const parent = document.layers[parentId];
		if (!parent?.visible) return false;
		parentId = parent.parentId;
	}
	return layer.visible;
};

export const ancestorLocked = (document: DocumentState, layer: LayerNode) => {
	if (layer.locked) return true;
	let parentId = layer.parentId;
	while (parentId) {
		const parent = document.layers[parentId];
		if (!parent) return false;
		if (parent.locked) return true;
		parentId = parent.parentId;
	}
	return false;
};

/** Document point expressed in the space `layer.transform.origin` uses. */
export const toOriginSpace = (
	document: DocumentState,
	layer: LayerNode,
	point: ToolPoint,
): ToolPoint => {
	if (!layer.parentId) return point;
	return documentToLayer(point, document, layer.parentId) ?? point;
};

export const layerContainsDocumentPoint = (
	document: DocumentState,
	layerId: string,
	point: ToolPoint,
) => {
	const layer = document.layers[layerId];
	if (!layer || !ancestorVisible(document, layer) || ancestorLocked(document, layer))
		return false;
	if (layer.kind === 'group') return false;
	return placedContains(toPlaced(layer.transform), toOriginSpace(document, layer, point));
};

export const topmostLayerAt = (document: DocumentState, point: ToolPoint) => {
	const layers = flattenLayerTree(document);
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index];
		if (!layer || layer.kind === 'group') continue;
		if (layerContainsDocumentPoint(document, layer.id, point)) return layer;
	}
	return null;
};

export const documentCornersFor = (
	document: DocumentState,
	layerId: string,
	transform: LayerTransform = document.layers[layerId]?.transform,
): ToolPoint[] => {
	const layer = document.layers[layerId];
	if (!layer || !transform) return [];
	const next =
		transform === layer.transform
			? document
			: {
					...document,
					layers: {...document.layers, [layerId]: {...layer, transform}},
				};
	return [
		{x: 0, y: 0},
		{x: transform.width, y: 0},
		{x: transform.width, y: transform.height},
		{x: 0, y: transform.height},
	]
		.map((corner) => layerToDocument(corner, next, layerId))
		.filter((corner): corner is ToolPoint => Boolean(corner));
};

export type PressTarget = {id: string; picked: boolean};

export const transformPressLayer = (input: {
	document: DocumentState;
	point: ToolPoint;
	activeLayerId: string | null;
	selectedLayerIds: readonly string[];
	autoSelect: boolean;
	command: boolean;
	shift: boolean;
}): PressTarget | null => {
	const {document, point} = input;
	const under = topmostLayerAt(document, point);
	const active = input.activeLayerId ? document.layers[input.activeLayerId] : undefined;
	const activeEditable =
		active &&
		active.kind !== 'group' &&
		ancestorVisible(document, active) &&
		!ancestorLocked(document, active)
			? active
			: undefined;
	const auto = input.autoSelect !== input.command;
	if (input.command && (input.shift || !input.autoSelect) && under)
		return {id: under.id, picked: true};
	const group =
		input.selectedLayerIds.length > 1 ||
		(input.selectedLayerIds.length === 1 &&
			document.layers[input.selectedLayerIds[0] ?? '']?.kind === 'group');
	if (group && input.activeLayerId) {
		const box = selectionBox(document, input.selectedLayerIds);
		const inside = box ? pointInBox(box, point) : false;
		if (inside || !auto || !under) return {id: input.activeLayerId, picked: false};
	}
	if (activeEditable && layerContainsDocumentPoint(document, activeEditable.id, point)) {
		if (auto && under && under.id !== activeEditable.id && paintedAbove(document, under.id, activeEditable.id))
			return {id: under.id, picked: true};
		return {id: activeEditable.id, picked: false};
	}
	if (auto && under) return {id: under.id, picked: true};
	return activeEditable ? {id: activeEditable.id, picked: false} : null;
};

const paintedAbove = (document: DocumentState, topId: string, bottomId: string) => {
	const order = flattenLayerTree(document).map((layer) => layer.id);
	return order.indexOf(topId) > order.indexOf(bottomId);
};

export const selectionBox = (document: DocumentState, layerIds: readonly string[]) => {
	const corners = layerIds.flatMap((id) => documentCornersFor(document, id));
	if (!corners.length) return null;
	const left = Math.min(...corners.map((corner) => corner.x));
	const top = Math.min(...corners.map((corner) => corner.y));
	const right = Math.max(...corners.map((corner) => corner.x));
	const bottom = Math.max(...corners.map((corner) => corner.y));
	return {left, top, right, bottom};
};

const pointInBox = (
	box: {left: number; top: number; right: number; bottom: number},
	point: ToolPoint,
) =>
	point.x >= box.left &&
	point.x <= box.right &&
	point.y >= box.top &&
	point.y <= box.bottom;

export const snapPlacedMove = (
	document: DocumentState,
	placed: PlacedTransform,
	excludedIds: readonly string[],
	zoom: number,
) => {
	const draft = fromPlaced(placed);
	const bounds = getTransformBounds(draft);
	const targets = snapTargets(document, excludedIds);
	const threshold = SNAP_SCREEN_PX / Math.max(zoom, 0.0001);
	let dx = 0;
	let dy = 0;
	let xGuide: number | undefined;
	let yGuide: number | undefined;
	for (const axis of ['x', 'y'] as const) {
		const edges =
			axis === 'x'
				? [bounds.left, bounds.centerX, bounds.right]
				: [bounds.top, bounds.centerY, bounds.bottom];
		let best: {move: number; target: number} | undefined;
		for (const edge of edges) {
			for (const target of targets) {
				if (target.axis !== axis) continue;
				const move = target.position - edge;
				if (Math.abs(move) > threshold) continue;
				if (!best || Math.abs(move) < Math.abs(best.move))
					best = {move, target: target.position};
			}
		}
		if (!best) continue;
		if (axis === 'x') {
			dx = best.move;
			xGuide = best.target;
		} else {
			dy = best.move;
			yGuide = best.target;
		}
	}
	return {
		placed: {...placed, originX: placed.originX + dx, originY: placed.originY + dy},
		guides: [
			...(xGuide === undefined
				? []
				: [{orientation: 'vertical' as const, position: xGuide}]),
			...(yGuide === undefined
				? []
				: [{orientation: 'horizontal' as const, position: yGuide}]),
		],
	};
};

const snapTargets = (document: DocumentState, excludedIds: readonly string[]) => {
	const excluded = new Set(excludedIds);
	const targets: Array<{axis: 'x' | 'y'; position: number}> = [
		{axis: 'x', position: 0},
		{axis: 'x', position: document.width / 2},
		{axis: 'x', position: document.width},
		{axis: 'y', position: 0},
		{axis: 'y', position: document.height / 2},
		{axis: 'y', position: document.height},
	];
	for (const layer of Object.values(document.layers)) {
		if (excluded.has(layer.id) || !layer.visible || layer.kind === 'group') continue;
		const bounds = getTransformBounds(layer.transform);
		targets.push(
			{axis: 'x', position: bounds.left},
			{axis: 'x', position: bounds.centerX},
			{axis: 'x', position: bounds.right},
			{axis: 'y', position: bounds.top},
			{axis: 'y', position: bounds.centerY},
			{axis: 'y', position: bounds.bottom},
		);
	}
	return targets;
};

export const sameLayerTransform = (left: LayerTransform, right: LayerTransform) =>
	left.originX === right.originX &&
	left.originY === right.originY &&
	left.width === right.width &&
	left.height === right.height &&
	left.rotation === right.rotation &&
	left.scaleX === right.scaleX &&
	left.scaleY === right.scaleY &&
	left.sampling === right.sampling;

export const pixelSizeOf = (document: DocumentState, layer: LayerNode) => {
	if (layer.content.kind === 'pixel') {
		const asset = document.assets[layer.content.assetId];
		if (asset?.width && asset.height) return {width: asset.width, height: asset.height};
	}
	return {width: layer.transform.width, height: layer.transform.height};
};
