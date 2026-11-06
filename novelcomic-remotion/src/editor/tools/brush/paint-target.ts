import {ACTIVE_SELECTION_ID, isEmptyShape, shapeFromRecord} from '../../document/selection-geometry';
import type {AssetRecord, DocumentState, LayerNode} from '../../document/types';
import type {ToolSessionContext} from '../types';

export type PaintTarget =
	| {ok: true; layer: LayerNode; asset: AssetRecord}
	| {ok: false; reason: string};

const isShown = (document: DocumentState, layer: LayerNode) => {
	const seen = new Set<string>();
	let current: LayerNode | undefined = layer;
	while (current && !seen.has(current.id)) {
		if (!current.visible) return false;
		seen.add(current.id);
		current = current.parentId ? document.layers[current.parentId] : undefined;
	}
	return true;
};

/**
 * Why a stroke cannot start, as Compositor explains a brush it refuses.
 * No selection means the whole layer can be painted. An explicit empty selection does not.
 */
export const paintTarget = (context: Pick<ToolSessionContext, 'document' | 'activeLayerId' | 'selectedLayerIds'>): PaintTarget => {
	if (context.selectedLayerIds.length > 1) return {ok: false, reason: '选中了多个图层。只选择一个才能在上面绘画。'};
	const layer = context.activeLayerId ? context.document.layers[context.activeLayerId] : undefined;
	if (!layer) return {ok: false, reason: '选择一个图层才能绘画。'};
	if (layer.kind === 'group') return {ok: false, reason: `「${layer.name}」是文件夹，本身没有像素。请改画里面的图层。`};
	if (!isShown(context.document, layer)) return {ok: false, reason: `「${layer.name}」已隐藏，或在隐藏的文件夹里。显示后才能绘画。`};
	if (layer.locked) return {ok: false, reason: `「${layer.name}」已锁定。解锁后才能绘画。`};
	if (layer.kind === 'adjustment') return {ok: false, reason: `「${layer.name}」是调整图层，没有可绘画的像素。`};
	if (layer.kind !== 'pixel' || layer.content.kind !== 'pixel') return {ok: false, reason: `「${layer.name}」没有可绘画的像素。`};
	const selection = context.document.selections[ACTIVE_SELECTION_ID];
	if (selection && isEmptyShape(shapeFromRecord(selection))) {
		return {ok: false, reason: '当前选区是空的，没有可绘画的位置。按 ⌘D 取消选择后即可在任意位置绘画。'};
	}
	const asset = context.document.assets[layer.content.assetId];
	if (!asset || asset.kind !== 'raster') return {ok: false, reason: `「${layer.name}」没有图像。`};
	return {ok: true, layer, asset};
};
