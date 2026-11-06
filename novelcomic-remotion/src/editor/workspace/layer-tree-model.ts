import {childLayerIds, isDescendant} from '../document/tree';
import type {DocumentState, LayerNode} from '../document/types';

export type LayerTreeRow = {
	layer: LayerNode;
	depth: number;
	parent: LayerNode | null;
};

export const buildLayerTreeRows = (
	document: DocumentState,
	expanded: ReadonlySet<string>,
): LayerTreeRow[] => {
	const rows: LayerTreeRow[] = [];
	const visit = (parentId: string | null, depth: number) => {
		for (const id of childLayerIds(document, parentId)) {
			const layer = document.layers[id];
			if (!layer) continue;
			rows.push({layer, depth, parent: parentId ? document.layers[parentId] ?? null : null});
			if (layer.kind === 'group' && expanded.has(layer.id)) visit(layer.id, depth + 1);
		}
	};
	visit(null, 0);
	return rows;
};

export const canDropLayer = (
	document: DocumentState,
	layerId: string,
	parentId: string | null,
): boolean => {
	if (layerId === parentId) return false;
	if (parentId === null) return true;
	const parent = document.layers[parentId];
	return Boolean(parent?.kind === 'group' && !isDescendant(document, parentId, layerId));
};

export const layerKindLabel = (layer: LayerNode): string => {
	if (layer.kind === 'group') return '组';
	if (layer.kind === 'adjustment') return '调整';
	if (layer.kind === 'text') return '文字';
	if (layer.kind === 'shape') return '形状';
	return '像素';
};
