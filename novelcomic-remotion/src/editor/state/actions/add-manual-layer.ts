import type {ImageAsset} from '../../assets/assets';
import type {ManualLayerPoint} from '../../comic/manual-layer-types';
import type {ComicLayerSemantic, LayerBounds} from '../../comic/types';
import type {ImageItem} from '../../items/image/image-item-type';
import {generateRandomId} from '../../utils/generate-random-id';
import type {EditorState, TrackType} from '../types';

const isZeroCrop = (item: ImageItem): boolean => {
	return (
		item.cropLeft === 0 &&
		item.cropTop === 0 &&
		item.cropRight === 0 &&
		item.cropBottom === 0
	);
};

const removeExistingManualLayer = (
	state: EditorState,
	layerId: string | undefined,
): EditorState => {
	if (!layerId) {
		return state;
	}

	const oldLayer = state.undoableState.comicEditLayers?.[layerId];
	if (!oldLayer) {
		return state;
	}

	const oldItemIds = Object.values(state.undoableState.items)
		.filter((item) => item.type === 'image' && item.layerId === layerId)
		.map((item) => item.id);
	const oldItemIdSet = new Set(oldItemIds);
	const oldTrackIds = state.undoableState.tracks
		.filter((track) => track.items.some((itemId) => oldItemIdSet.has(itemId)))
		.map((track) => track.id);
	const oldTrackIdSet = new Set(oldTrackIds);
	const nextItems = {...state.undoableState.items};
	for (const itemId of oldItemIds) {
		delete nextItems[itemId];
	}

	const nextLayers = {...state.undoableState.comicEditLayers};
	delete nextLayers[layerId];

	const nextAssets = {...state.undoableState.assets};
	const nextAssetIds = new Set([
		oldLayer.maskAssetId,
		oldLayer.cutoutAssetId,
		oldLayer.cleanPlateAssetId,
	]);
	for (const assetId of nextAssetIds) {
		if (!assetId) {
			continue;
		}

		const stillReferenced =
			Object.values(nextItems).some((item) => {
				return item.type === 'image' && item.assetId === assetId;
			}) ||
			Object.values(nextLayers).some((layer) => {
				return (
					layer.maskAssetId === assetId ||
					layer.cutoutAssetId === assetId ||
					layer.cleanPlateAssetId === assetId
				);
			});
		if (!stillReferenced) {
			delete nextAssets[assetId];
		}
	}

	return {
		...state,
		selectedItems: state.selectedItems.filter(
			(itemId) => !oldItemIdSet.has(itemId),
		),
		undoableState: {
			...state.undoableState,
			items: nextItems,
			assets: nextAssets,
			tracks: state.undoableState.tracks.filter(
				(track) => !oldTrackIdSet.has(track.id),
			),
			comicEditLayers: nextLayers,
			shots: state.undoableState.shots?.map((shot) => ({
				...shot,
				layerTrackIds: shot.layerTrackIds.filter(
					(trackId) => !oldTrackIdSet.has(trackId),
				),
			})),
		},
	};
};

export type AddManualLayerInput = {
	state: EditorState;
	sourceItem: ImageItem;
	sourceAsset: ImageAsset;
	maskAsset: ImageAsset;
	cutoutAsset: ImageAsset;
	polygon: ManualLayerPoint[];
	bounds: LayerBounds;
	name: string;
	semantic: ComicLayerSemantic;
	layerId?: string;
	replaceLayerId?: string;
};

export const addManualLayerToState = ({
	state: initialState,
	sourceItem,
	sourceAsset,
	maskAsset,
	cutoutAsset,
	polygon,
	bounds,
	name,
	semantic,
	layerId = `manual-layer-${generateRandomId()}`,
	replaceLayerId,
}: AddManualLayerInput): EditorState => {
	if (!isZeroCrop(sourceItem)) {
		throw new Error(
			'Manual layer extraction does not support cropped source items',
		);
	}
	if (sourceItem.rotation !== 0 || sourceItem.motion) {
		throw new Error(
			'Manual layer extraction requires a static, unrotated source image',
		);
	}
	if (
		sourceAsset.width <= 0 ||
		sourceAsset.height <= 0 ||
		bounds.width <= 0 ||
		bounds.height <= 0 ||
		bounds.x < 0 ||
		bounds.y < 0 ||
		bounds.x + bounds.width > sourceAsset.width ||
		bounds.y + bounds.height > sourceAsset.height
	) {
		throw new Error('Manual layer bounds are outside the source image');
	}
	if (
		maskAsset.width !== sourceAsset.width ||
		maskAsset.height !== sourceAsset.height
	) {
		throw new Error('Manual mask dimensions must match the source image');
	}
	if (
		cutoutAsset.width !== bounds.width ||
		cutoutAsset.height !== bounds.height
	) {
		throw new Error('Manual cutout dimensions must match its bounds');
	}

	const state = removeExistingManualLayer(initialState, replaceLayerId);
	const nextLayerId = replaceLayerId ?? layerId;
	const itemId = `manual-item-${generateRandomId()}`;
	const trackId = `manual-track-${generateRandomId()}`;
	const left =
		sourceItem.left + (bounds.x / sourceAsset.width) * sourceItem.width;
	const top =
		sourceItem.top + (bounds.y / sourceAsset.height) * sourceItem.height;
	const width = (bounds.width / sourceAsset.width) * sourceItem.width;
	const height = (bounds.height / sourceAsset.height) * sourceItem.height;

	const item: ImageItem = {
		...sourceItem,
		id: itemId,
		assetId: cutoutAsset.id,
		layerId: nextLayerId,
		top,
		left,
		width,
		height,
		cropLeft: 0,
		cropTop: 0,
		cropRight: 0,
		cropBottom: 0,
		motion: undefined,
		spriteAssetIds: undefined,
	};
	const track: TrackType = {
		id: trackId,
		items: [item.id],
		hidden: false,
		muted: false,
		name,
		shotId: sourceItem.shotId,
		semantic,
		role: 'cutout',
	};

	const sourceTrackIndex = state.undoableState.tracks.findIndex((candidate) =>
		candidate.items.includes(sourceItem.id),
	);
	const sourceTrack = state.undoableState.tracks[sourceTrackIndex];
	const insertionIndex = sourceTrackIndex < 0 ? 0 : sourceTrackIndex;
	const tracks = [
		...state.undoableState.tracks.slice(0, insertionIndex),
		track,
		...state.undoableState.tracks.slice(insertionIndex),
	].map((candidate) => {
		if (candidate.id === sourceTrack?.id && candidate.role === undefined) {
			return {...candidate, role: 'source' as const};
		}

		return candidate;
	});

	const shots = state.undoableState.shots?.map((shot) => {
		if (shot.id !== sourceItem.shotId) {
			return shot;
		}

		const sourceIndex = shot.layerTrackIds.findIndex((id) => {
			return id === state.undoableState.tracks[sourceTrackIndex]?.id;
		});
		const nextIds = [...shot.layerTrackIds];
		nextIds.splice(sourceIndex < 0 ? 0 : sourceIndex, 0, track.id);
		return {...shot, layerTrackIds: nextIds};
	});

	const nextLayers = {
		...(state.undoableState.comicEditLayers ?? {}),
		[nextLayerId]: {
			id: nextLayerId,
			name,
			semantic,
			sourceAssetId: sourceAsset.id,
			sourceItemId: sourceItem.id,
			sourceTrackId: sourceTrack?.id,
			shotId: sourceItem.shotId,
			sourceCanvas: {
				width: sourceAsset.width,
				height: sourceAsset.height,
			},
			bounds: {...bounds},
			polygon: polygon.map((point) => ({...point})),
			maskAssetId: maskAsset.id,
			cutoutAssetId: cutoutAsset.id,
			cutoutItemId: item.id,
			cutoutTrackId: track.id,
			cleanPlateStatus: 'missing' as const,
			finalCompositionReady: false,
			visible: true,
			locked: false,
			opacity: 1,
			zIndex: tracks.length - insertionIndex,
		},
	};

	return {
		...state,
		selectedItems: [item.id],
		assetStatus: {
			...state.assetStatus,
			[maskAsset.id]: state.assetStatus[maskAsset.id] ?? {
				type: 'pending-upload',
			},
			[cutoutAsset.id]: state.assetStatus[cutoutAsset.id] ?? {
				type: 'pending-upload',
			},
		},
		undoableState: {
			...state.undoableState,
			assets: {
				...state.undoableState.assets,
				[maskAsset.id]: maskAsset,
				[cutoutAsset.id]: cutoutAsset,
			},
			items: {
				...state.undoableState.items,
				[item.id]: item,
			},
			tracks,
			shots,
			comicEditLayers: nextLayers,
		},
	};
};
