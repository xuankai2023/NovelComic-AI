import type {ImageAsset} from '../../assets/assets';
import type {ImageItem} from '../../items/image/image-item-type';
import {generateRandomId} from '../../utils/generate-random-id';
import type {EditorState} from '../types';

export type ApplyCleanPlateInput = {
	state: EditorState;
	layerId: string;
	cleanPlateAsset: ImageAsset;
};

const findSourceItem = (
	state: EditorState,
	layerId: string,
): ImageItem | undefined => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	if (!layer) {
		return undefined;
	}

	const byRecordedId = layer.sourceItemId
		? state.undoableState.items[layer.sourceItemId]
		: undefined;
	if (byRecordedId?.type === 'image') {
		return byRecordedId;
	}

	return Object.values(state.undoableState.items).find((item) => {
		return (
			item.type === 'image' &&
			item.assetId === layer.sourceAssetId &&
			item.layerId === undefined &&
			(item.shotId === undefined || item.shotId === layer.shotId)
		);
	}) as ImageItem | undefined;
};

const sourceTrackFor = (state: EditorState, layerId: string) => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	if (!layer) {
		return undefined;
	}

	return state.undoableState.tracks.find((track) => {
		return (
			track.id === layer.sourceTrackId ||
			(layer.sourceItemId !== undefined &&
				track.items.includes(layer.sourceItemId))
		);
	});
};

const withCleanPlateReferences = (
	state: EditorState,
	layerId: string,
	cleanPlateAsset: ImageAsset,
): EditorState => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	if (!layer) {
		throw new Error(`Manual layer ${layerId} does not exist`);
	}

	const sourceItem = findSourceItem(state, layerId);
	if (!sourceItem) {
		throw new Error(`Source item for manual layer ${layerId} does not exist`);
	}

	const sourceTrack = sourceTrackFor(state, layerId);
	if (!sourceTrack) {
		throw new Error(`Source track for manual layer ${layerId} does not exist`);
	}

	const cleanPlateItemId =
		layer.cleanPlateItemId ?? `manual-clean-plate-item-${generateRandomId()}`;
	const cleanPlateTrackId =
		layer.cleanPlateTrackId ?? `manual-clean-plate-track-${generateRandomId()}`;
	const existingCleanPlateItem = state.undoableState.items[cleanPlateItemId];
	const cleanPlateItem: ImageItem = {
		...(existingCleanPlateItem?.type === 'image'
			? existingCleanPlateItem
			: sourceItem),
		id: cleanPlateItemId,
		assetId: cleanPlateAsset.id,
		layerId,
		top: sourceItem.top,
		left: sourceItem.left,
		width: sourceItem.width,
		height: sourceItem.height,
		cropLeft: 0,
		cropTop: 0,
		cropRight: 0,
		cropBottom: 0,
		motion: undefined,
		spriteAssetIds: undefined,
	};
	const cleanPlateTrack = {
		id: cleanPlateTrackId,
		items: [cleanPlateItemId],
		hidden: false,
		muted: false,
		name: `${layer.name} Clean Plate`,
		shotId: sourceItem.shotId,
		semantic: 'background' as const,
		role: 'clean-plate' as const,
	};

	const tracksWithoutCleanPlate = state.undoableState.tracks.filter(
		(track) => track.id !== cleanPlateTrackId,
	);
	const sourceTrackIndex = tracksWithoutCleanPlate.findIndex(
		(track) => track.id === sourceTrack.id,
	);
	const insertAt =
		sourceTrackIndex < 0 ? tracksWithoutCleanPlate.length : sourceTrackIndex;
	const tracks = [
		...tracksWithoutCleanPlate.slice(0, insertAt),
		cleanPlateTrack,
		...tracksWithoutCleanPlate.slice(insertAt),
	].map((track) => {
		if (track.id === sourceTrack.id) {
			return {...track, role: 'source' as const, hidden: true};
		}
		return track;
	});

	const shotId = sourceItem.shotId;
	const shots = state.undoableState.shots?.map((shot) => {
		if (shot.id !== shotId) {
			return shot;
		}

		const withoutCleanPlate = shot.layerTrackIds.filter(
			(trackId) => trackId !== cleanPlateTrackId,
		);
		const sourceIndex = withoutCleanPlate.indexOf(sourceTrack.id);
		const nextLayerTrackIds = [...withoutCleanPlate];
		nextLayerTrackIds.splice(
			sourceIndex < 0 ? nextLayerTrackIds.length : sourceIndex,
			0,
			cleanPlateTrackId,
		);
		return {...shot, layerTrackIds: nextLayerTrackIds};
	});

	return {
		...state,
		assetStatus: {
			...state.assetStatus,
			[cleanPlateAsset.id]: state.assetStatus[cleanPlateAsset.id] ?? {
				type: 'pending-upload',
			},
		},
		undoableState: {
			...state.undoableState,
			assets: {
				...state.undoableState.assets,
				[cleanPlateAsset.id]: cleanPlateAsset,
			},
			items: {
				...state.undoableState.items,
				[cleanPlateItemId]: cleanPlateItem,
			},
			tracks,
			shots,
			comicEditLayers: {
				...state.undoableState.comicEditLayers,
				[layerId]: {
					...layer,
					sourceItemId: sourceItem.id,
					sourceTrackId: sourceTrack.id,
					cleanPlateAssetId: cleanPlateAsset.id,
					cleanPlateItemId,
					cleanPlateTrackId,
					cleanPlateStatus: 'ready',
					finalCompositionReady: true,
				},
			},
		},
	};
};

/**
 * Adds a separate full-canvas Clean Plate item and hides the L0 source track
 * only after the clean plate is valid. The source item and source asset are
 * intentionally untouched so Source mode and recovery remain lossless.
 */
export const applyCleanPlateToState = ({
	state,
	layerId,
	cleanPlateAsset,
}: ApplyCleanPlateInput): EditorState => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	if (!layer) {
		throw new Error(`Manual layer ${layerId} does not exist`);
	}

	if (cleanPlateAsset.type !== 'image') {
		throw new Error('Clean plate asset must be an image');
	}
	if (
		cleanPlateAsset.width !== layer.sourceCanvas.width ||
		cleanPlateAsset.height !== layer.sourceCanvas.height
	) {
		throw new Error('Clean plate dimensions must match the source canvas');
	}

	const sourceItem = findSourceItem(state, layerId);
	if (!sourceItem) {
		throw new Error(`Source item for manual layer ${layerId} does not exist`);
	}

	return withCleanPlateReferences(state, layerId, cleanPlateAsset);
};

export const markCleanPlateProcessing = (
	state: EditorState,
	layerId: string,
): EditorState => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	if (!layer) {
		throw new Error(`Manual layer ${layerId} does not exist`);
	}

	return {
		...state,
		undoableState: {
			...state.undoableState,
			comicEditLayers: {
				...state.undoableState.comicEditLayers,
				[layerId]: {
					...layer,
					cleanPlateStatus: 'processing',
					finalCompositionReady: false,
				},
			},
		},
	};
};

export const markCleanPlateFailed = (
	state: EditorState,
	layerId: string,
): EditorState => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	if (!layer) {
		throw new Error(`Manual layer ${layerId} does not exist`);
	}

	const sourceTrackId = layer.sourceTrackId;
	return {
		...state,
		undoableState: {
			...state.undoableState,
			tracks: state.undoableState.tracks.map((track) => {
				if (track.id === sourceTrackId) {
					return {...track, hidden: false, role: 'source' as const};
				}
				if (track.id === layer.cleanPlateTrackId) {
					return {...track, hidden: true, role: 'clean-plate' as const};
				}
				return track;
			}),
			comicEditLayers: {
				...state.undoableState.comicEditLayers,
				[layerId]: {
					...layer,
					cleanPlateStatus: 'failed',
					finalCompositionReady: false,
				},
			},
		},
	};
};

export const restoreOriginalSourceAsset = (
	state: EditorState,
	layerId: string,
): EditorState => {
	const layer = state.undoableState.comicEditLayers?.[layerId];
	if (!layer) {
		throw new Error(`Manual layer ${layerId} does not exist`);
	}

	const sourceItem = findSourceItem(state, layerId);
	if (!sourceItem) {
		throw new Error(`Source item for manual layer ${layerId} does not exist`);
	}

	const cleanPlateItemId = layer.cleanPlateItemId;
	const cleanPlateTrackId = layer.cleanPlateTrackId;
	const items = {...state.undoableState.items};
	if (cleanPlateItemId) {
		delete items[cleanPlateItemId];
	}
	const tracks = state.undoableState.tracks
		.filter((track) => track.id !== cleanPlateTrackId)
		.map((track) => {
			if (track.id === layer.sourceTrackId) {
				return {...track, hidden: false, role: 'source' as const};
			}
			return track;
		});
	const shots = state.undoableState.shots?.map((shot) => ({
		...shot,
		layerTrackIds: cleanPlateTrackId
			? shot.layerTrackIds.filter((trackId) => trackId !== cleanPlateTrackId)
			: shot.layerTrackIds,
	}));

	return {
		...state,
		selectedItems: cleanPlateItemId
			? state.selectedItems.filter((itemId) => itemId !== cleanPlateItemId)
			: state.selectedItems,
		undoableState: {
			...state.undoableState,
			items,
			tracks,
			shots,
			comicEditLayers: {
				...state.undoableState.comicEditLayers,
				[layerId]: {
					...layer,
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
