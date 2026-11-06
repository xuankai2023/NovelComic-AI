import type {EditorState} from '../types';

const layerItemIds = (state: EditorState, layerId: string): Set<string> => {
	return new Set(
		Object.values(state.undoableState.items)
			.filter((item) => item.type === 'image' && item.layerId === layerId)
			.map((item) => item.id),
	);
};

const layerTrackIds = (
	state: EditorState,
	layerId: string,
	itemIds: Set<string>,
): Set<string> => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	return new Set(
		state.undoableState.tracks
			.filter((track) => {
				return (
					track.id === layer?.cutoutTrackId ||
					track.id === layer?.cleanPlateTrackId ||
					track.items.some((itemId) => itemIds.has(itemId))
				);
			})
			.map((track) => track.id),
	);
};

/**
 * Removes a manual layer's derived tracks and assets while retaining the
 * original L0 source item, source track, and source asset.
 */
export const deleteManualLayer = (
	state: EditorState,
	layerId: string,
): EditorState => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	if (!layer) {
		return state;
	}

	const itemIds = layerItemIds(state, layerId);
	if (layer.sourceItemId) {
		itemIds.delete(layer.sourceItemId);
	}
	const trackIds = layerTrackIds(state, layerId, itemIds);
	if (layer.sourceTrackId) {
		trackIds.delete(layer.sourceTrackId);
	}

	const items = {...state.undoableState.items};
	for (const itemId of itemIds) {
		delete items[itemId];
	}

	const assets = {...state.undoableState.assets};
	const remainingLayers = Object.fromEntries(
		Object.entries(state.undoableState.comicEditLayers ?? {}).filter(
			([id]) => id !== layerId,
		),
	);
	for (const assetId of [
		layer.maskAssetId,
		layer.cutoutAssetId,
		layer.cleanPlateAssetId,
	]) {
		if (!assetId) {
			continue;
		}

		const stillReferenced =
			Object.values(items).some((item) => {
				return item.type === 'image' && item.assetId === assetId;
			}) ||
			Object.values(remainingLayers).some((candidate) => {
				return (
					candidate.maskAssetId === assetId ||
					candidate.cutoutAssetId === assetId ||
					candidate.cleanPlateAssetId === assetId
				);
			});
		if (!stillReferenced) {
			delete assets[assetId];
		}
	}

	const tracks = state.undoableState.tracks.filter(
		(track) => !trackIds.has(track.id),
	);
	const shots = state.undoableState.shots?.map((shot) => ({
		...shot,
		layerTrackIds: shot.layerTrackIds.filter(
			(trackId) => !trackIds.has(trackId),
		),
	}));
	return {
		...state,
		selectedItems: state.selectedItems.filter((itemId) => !itemIds.has(itemId)),
		undoableState: {
			...state.undoableState,
			items,
			assets,
			tracks,
			shots,
			comicEditLayers: remainingLayers,
		},
	};
};

export const replaceManualLayerDerivedAssets = ({
	state,
	layerId,
	maskAsset,
	cutoutAsset,
	bounds,
}: {
	state: EditorState;
	layerId: string;
	maskAsset: NonNullable<EditorState['undoableState']['assets'][string]>;
	cutoutAsset: NonNullable<EditorState['undoableState']['assets'][string]>;
	bounds: {x: number; y: number; width: number; height: number};
}): EditorState => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	if (!layer || maskAsset.type !== 'image' || cutoutAsset.type !== 'image') {
		return state;
	}

	if (
		maskAsset.width !== layer.sourceCanvas.width ||
		maskAsset.height !== layer.sourceCanvas.height ||
		cutoutAsset.width !== Math.round(bounds.width) ||
		cutoutAsset.height !== Math.round(bounds.height)
	) {
		throw new Error('Regenerated manual layer assets have invalid dimensions');
	}

	const cutoutItem = layer.cutoutItemId
		? state.undoableState.items[layer.cutoutItemId]
		: undefined;
	if (!cutoutItem || cutoutItem.type !== 'image') {
		throw new Error(`Manual layer ${layerId} cutout item does not exist`);
	}

	const left =
		cutoutItem.left -
		((layer.bounds.x - bounds.x) / layer.sourceCanvas.width) *
			cutoutItem.width;
	const top =
		cutoutItem.top -
		((layer.bounds.y - bounds.y) / layer.sourceCanvas.height) *
			cutoutItem.height;
	const width =
		(bounds.width / layer.sourceCanvas.width) *
		(layer.sourceCanvas.width / layer.bounds.width) *
		cutoutItem.width;
	const height =
		(bounds.height / layer.sourceCanvas.height) *
		(layer.sourceCanvas.height / layer.bounds.height) *
		cutoutItem.height;

	const items = {...state.undoableState.items};
	items[cutoutItem.id] = {
		...cutoutItem,
		assetId: cutoutAsset.id,
		left,
		top,
		width,
		height,
		motion: undefined,
		spriteAssetIds: undefined,
	};

	const cleanPlateItemId = layer.cleanPlateItemId;
	if (cleanPlateItemId) {
		delete items[cleanPlateItemId];
	}

	const oldDerivedIds = new Set([
		layer.maskAssetId,
		layer.cutoutAssetId,
		layer.cleanPlateAssetId,
	]);
	const assets = {
		...state.undoableState.assets,
		[maskAsset.id]: maskAsset,
		[cutoutAsset.id]: cutoutAsset,
	};
	for (const assetId of oldDerivedIds) {
		if (
			assetId &&
			assetId !== maskAsset.id &&
			assetId !== cutoutAsset.id &&
			!Object.values(items).some(
				(item) => item.type === 'image' && item.assetId === assetId,
			)
		) {
			delete assets[assetId];
		}
	}

	const tracks = state.undoableState.tracks.filter(
		(track) => track.id !== layer.cleanPlateTrackId,
	);
	const shots = state.undoableState.shots?.map((shot) => ({
		...shot,
		layerTrackIds: layer.cleanPlateTrackId
			? shot.layerTrackIds.filter(
					(trackId) => trackId !== layer.cleanPlateTrackId,
				)
			: shot.layerTrackIds,
	}));

	return {
		...state,
		selectedItems: state.selectedItems.includes(cutoutItem.id)
			? state.selectedItems
			: [cutoutItem.id],
		undoableState: {
			...state.undoableState,
			assets,
			items,
			tracks,
			shots,
			comicEditLayers: {
				...state.undoableState.comicEditLayers,
				[layerId]: {
					...layer,
					bounds: {...bounds},
					maskAssetId: maskAsset.id,
					cutoutAssetId: cutoutAsset.id,
					cleanPlateAssetId: undefined,
					cleanPlateItemId: undefined,
					cleanPlateTrackId: undefined,
					cleanPlateStatus: 'missing',
					finalCompositionReady: false,
				},
			},
		},
	};
};
