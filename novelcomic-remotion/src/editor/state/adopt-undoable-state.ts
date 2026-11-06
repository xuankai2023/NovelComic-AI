import type {AssetState} from '../assets/assets';
import type {EditorState, UndoableState} from './types';

const statusForAsset = (asset: UndoableState['assets'][string]): AssetState => {
	if (asset.type === 'caption' || asset.remoteUrl) {
		return {type: 'uploaded'};
	}

	return {
		type: 'error',
		error: new Error('Asset has no local or remote source'),
		canRetry: false,
	};
};

/**
 * Apply a server-side compose result without losing the editor-only status
 * fields that are not part of UndoableState.
 */
export const adoptUndoableState = (
	state: EditorState,
	undoableState: UndoableState,
): EditorState => {
	const assetStatus = {...state.assetStatus};
	for (const [assetId, asset] of Object.entries(undoableState.assets)) {
		assetStatus[assetId] = assetStatus[assetId] ?? statusForAsset(asset);
	}

	return {
		...state,
		undoableState,
		assetStatus,
		selectedItems: [],
		textItemEditing: null,
		itemSelectedForCrop: null,
	};
};
