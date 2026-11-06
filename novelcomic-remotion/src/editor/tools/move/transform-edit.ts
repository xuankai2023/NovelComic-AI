import {createDocumentCommand} from '../../commands/document-command-types';
import type {DocumentCommand} from '../../commands/document-command-types';
import type {DocumentState, LayerNode, LayerTransform} from '../../document/types';
import {clearLayerWarps} from './distort-preview';
import {
	describeTransformSelection,
	documentPlacedFromLocal,
	isValidPlaced,
	layerTransformsForBox,
	localTransformFromDocumentPlaced,
	maskPlacementAfterMove,
	pixelSizeOf,
	sameLayerPlacement,
	sameLayerTransform,
	type PlacedTransform,
	type TransformSelection,
} from './transform-math';
import type {ToolPoint} from '../types';

/** A Move-bar or distort edit. Numbers preview into `draft`; Apply or leaving a field writes one undo step. */
export type TransformEdit = {
	base: DocumentState;
	selection: TransformSelection;
	box: PlacedTransform;
	draft: PlacedTransform;
	latest: Record<string, LayerTransform>;
	pixelSize: {width: number; height: number};
	/** Cmd-dragged corners. While set, the number row waits and Apply resamples the fitted box. */
	corners: ToolPoint[] | null;
	/** Waiting for Cancel / Apply. A field edit is not persistent. */
	persistent: boolean;
	/** Opened by the Move bar. Applied once the field is done, as one undo step. */
	fromFields: boolean;
	/** An unlinked mask, transformed on its own. `latest` is its placement, not the layer. */
	mask: boolean;
};

let edit: TransformEdit | null = null;
const listeners = new Set<() => void>();

const emit = () => {
	for (const listener of listeners) listener();
};

export const getTransformEdit = () => edit;

export const subscribeTransformEdit = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const resetTransformEdit = () => {
	edit = null;
	emit();
};

const pixelSizeFor = (document: DocumentState, selection: TransformSelection) => {
	if (selection.group && selection.box)
		return {width: selection.box.placedWidth, height: selection.box.placedHeight};
	const layer = document.layers[selection.ids[0] ?? ''];
	return layer && selection.box
		? pixelSizeOf(document, layer)
		: {width: 1, height: 1};
};

const withSampling = (box: PlacedTransform, document: DocumentState, activeLayerId: string | null) => {
	const sampling = document.layers[activeLayerId ?? '']?.transform.sampling;
	return sampling ? {...box, sampling} : box;
};

const maskSelection = (
	document: DocumentState,
	layerId: string,
): TransformSelection | null => {
	const layer = document.layers[layerId];
	if (!layer?.mask || layer.mask.linkedToLayer) return null;
	const local = layer.mask.placement ?? layer.transform;
	const box = documentPlacedFromLocal(document, layer, local);
	return {
		ids: [layer.id],
		group: false,
		uniform: !layer.parentId,
		box,
		members: {[layer.id]: box},
	};
};

export const beginTransformEdit = (input: {
	document: DocumentState;
	selectedIds: readonly string[];
	activeLayerId: string | null;
	persistent?: boolean;
	fromFields?: boolean;
	mask?: boolean;
}): TransformEdit | null => {
	if (edit) return edit;
	const selection = input.mask
		? input.activeLayerId
			? maskSelection(input.document, input.activeLayerId)
			: null
		: describeTransformSelection(input.document, input.selectedIds);
	if (!selection?.box || !selection.ids.length) return null;
	const layer = input.document.layers[selection.ids[0] ?? ''];
	if (!layer) return null;
	const box =
		selection.group || input.mask
			? selection.box
			: withSampling(selection.box, input.document, input.activeLayerId);
	const maskPlaced = documentPlacedFromLocal(input.document, layer, layer.transform);
	const next: TransformEdit = {
		base: input.document,
		selection: {...selection, box},
		box,
		draft: box,
		latest: input.mask
			? {[layer.id]: localTransformFromDocumentPlaced(input.document, layer, box)}
			: layerTransformsForBox(input.document, {...selection, box}, box, box),
		pixelSize: input.mask
			? {width: maskPlaced.placedWidth, height: maskPlaced.placedHeight}
			: pixelSizeFor(input.document, {...selection, box}),
		corners: null,
		persistent: input.persistent ?? false,
		fromFields: input.fromFields ?? false,
		mask: input.mask ?? false,
	};
	edit = next;
	emit();
	return next;
};

const withPlacement = (layer: LayerNode, placement: LayerTransform | undefined): LayerNode => {
	if (!layer.mask) return layer;
	const mask = {...layer.mask};
	if (placement) mask.placement = placement;
	else delete mask.placement;
	return {...layer, mask};
};

const previewDocument = (current: TransformEdit): DocumentState => {
	const layers = {...current.base.layers};
	for (const [id, transform] of Object.entries(current.latest)) {
		const layer = layers[id];
		if (!layer) continue;
		if (current.mask) {
			layers[id] = withPlacement(
				layer,
				sameLayerPlacement(transform, layer.transform) ? undefined : transform,
			);
			continue;
		}
		const moved = {...layer, transform};
		layers[id] = layer.mask
			? withPlacement(moved, maskPlacementAfterMove(layer.mask, layer.transform, transform))
			: moved;
	}
	return {...current.base, layers};
};

const latestForDraft = (current: TransformEdit, draft: PlacedTransform) => {
	if (!current.mask) return layerTransformsForBox(current.base, current.selection, current.box, draft);
	const id = current.selection.ids[0];
	const layer = id ? current.base.layers[id] : undefined;
	const original = id ? current.selection.members[id] : undefined;
	if (!id || !layer || !original) return {};
	return {
		[id]: localTransformFromDocumentPlaced(current.base, layer, {
			...draft,
			contentWidth: original.contentWidth,
			contentHeight: original.contentHeight,
		}),
	};
};

/** Show `draft` on the canvas without writing history. */
export const previewTransformEdit = (draft: PlacedTransform): DocumentState | null => {
	if (!edit || !isValidPlaced(draft)) return null;
	const latest = latestForDraft(edit, draft);
	edit = {...edit, draft, latest};
	emit();
	return previewDocument(edit);
};

export const rememberTransformEdit = (input: {
	base: DocumentState;
	selection: TransformSelection;
	box: PlacedTransform;
	draft: PlacedTransform;
	latest: Record<string, LayerTransform>;
	corners: ToolPoint[] | null;
}) => {
	const pixelSize = edit?.pixelSize ?? pixelSizeFor(input.base, input.selection);
	edit = {
		base: edit?.base ?? input.base,
		selection: edit?.selection ?? input.selection,
		box: edit?.box ?? input.box,
		draft: input.draft,
		latest: input.latest,
		pixelSize,
		corners: input.corners ? input.corners.map((corner) => ({...corner})) : null,
		persistent: true,
		fromFields: false,
		mask: edit?.mask ?? false,
	};
	emit();
};

export const commitTransformEdit = (
	dispatch: (commands: readonly DocumentCommand[]) => void,
): boolean => {
	const current = edit;
	if (!current) return false;
	edit = null;
	emit();
	clearLayerWarps();
	const commands: DocumentCommand[] = [];
	const transactionId = `transform-${current.base.projectId}-${Date.now()}`;
	for (const [id, transform] of Object.entries(current.latest)) {
		const layer = current.base.layers[id];
		if (!layer) continue;
		if (current.mask) {
			if (!layer.mask) continue;
			const next = sameLayerPlacement(transform, layer.transform) ? null : transform;
			const previous = layer.mask.placement ?? null;
			const changed =
				next === null
					? previous !== null
					: !previous || !sameLayerTransform(previous, next);
			if (!changed) continue;
			commands.push(
				createDocumentCommand({
					type: 'mask.update',
					projectId: current.base.projectId,
					payload: {layerId: id, changes: {placement: next}},
					transactionId,
				}),
			);
			continue;
		}
		if (!sameLayerTransform(layer.transform, transform)) {
			commands.push(
				createDocumentCommand({
					type: 'layer.transform',
					projectId: current.base.projectId,
					payload: {layerId: id, transform},
					transactionId,
				}),
			);
		}
		if (!layer.mask) continue;
		const placement = maskPlacementAfterMove(layer.mask, layer.transform, transform);
		const previous = layer.mask.placement ?? null;
		const next = placement ?? null;
		const changed =
			next === null ? previous !== null : !previous || !sameLayerTransform(previous, next);
		if (!changed) continue;
		commands.push(
			createDocumentCommand({
				type: 'mask.update',
				projectId: current.base.projectId,
				payload: {layerId: id, changes: {placement: next}},
				transactionId,
			}),
		);
	}
	if (commands.length) dispatch(commands);
	return true;
};

export const cancelTransformEdit = () => {
	if (!edit) return false;
	edit = null;
	emit();
	clearLayerWarps();
	return true;
};
