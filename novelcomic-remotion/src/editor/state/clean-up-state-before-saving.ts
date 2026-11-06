import {AssetState, EditorStarterAsset} from '../assets/assets';
import {collectAssetIdsFromItem} from '../assets/utils';
import {collectAssetIdsFromComicEditLayers} from '../comic/manual-layer-types';
import {EditorState, UndoableState} from './types';

const collectUsedAssets = (
	items: UndoableState['items'],
	assets: Record<string, EditorStarterAsset>,
	comicEditLayers: UndoableState['comicEditLayers'],
): EditorStarterAsset[] => {
	const used: EditorStarterAsset[] = [];
	const seen = new Set<string>();

	for (const item of Object.values(items)) {
		for (const assetId of collectAssetIdsFromItem(item)) {
			if (seen.has(assetId)) {
				continue;
			}

			const asset = assets[assetId];
			if (!asset) {
				continue;
			}

			seen.add(assetId);
			used.push(asset);
		}
	}

	for (const assetId of collectAssetIdsFromComicEditLayers(comicEditLayers)) {
		if (seen.has(assetId)) {
			continue;
		}

		const asset = assets[assetId];
		if (!asset) {
			continue;
		}

		seen.add(assetId);
		used.push(asset);
	}

	return used;
};

export const cleanUpStateBeforeSaving = (
	state: UndoableState,
): UndoableState => {
	const newAssets: Record<string, EditorStarterAsset> = {};

	for (const asset of collectUsedAssets(
		state.items,
		state.assets,
		state.comicEditLayers,
	)) {
		newAssets[asset.id] = asset;
	}

	return {
		...state,
		assets: newAssets,
	};
};

export const cleanUpAssetStatus = (state: EditorState): EditorState => {
	const usedAssetIds = new Set<string>();

	for (const asset of collectUsedAssets(
		state.undoableState.items,
		state.undoableState.assets,
		state.undoableState.comicEditLayers,
	)) {
		usedAssetIds.add(asset.id);
	}

	// Keep only status for used assets
	const newAssetStatus: Record<string, AssetState> = {};
	for (const assetId of usedAssetIds) {
		if (state.assetStatus[assetId]) {
			newAssetStatus[assetId] = state.assetStatus[assetId];
		}
	}

	return {
		...state,
		assetStatus: newAssetStatus,
	};
};
