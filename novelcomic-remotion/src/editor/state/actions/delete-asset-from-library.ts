import {collectAssetIdsFromItem} from '../../assets/utils';
import {collectAssetIdsFromComicEditLayers} from '../../comic/manual-layer-types';
import {EditorState} from '../types';

const isAssetUsedByTimeline = ({
	state,
	assetId,
}: {
	state: EditorState;
	assetId: string;
}) => {
	return Object.values(state.undoableState.items).some((item) => {
		return collectAssetIdsFromItem(item).includes(assetId);
	});
};

const isAssetUsedByComicLayer = ({
	state,
	assetId,
}: {
	state: EditorState;
	assetId: string;
}) => {
	return collectAssetIdsFromComicEditLayers(
		state.undoableState.comicEditLayers,
	).includes(assetId);
};

const shouldKeepAssetInState = ({
	state,
	assetId,
}: {
	state: EditorState;
	assetId: string;
}) => {
	const status = state.assetStatus[assetId];
	return (
		isAssetUsedByTimeline({state, assetId}) ||
		isAssetUsedByComicLayer({state, assetId}) ||
		status?.type === 'pending-upload' ||
		status?.type === 'in-progress'
	);
};

export const deleteAssetFromLibrary = (
	state: EditorState,
	assetId: string,
): EditorState => {
	const asset = state.undoableState.assets[assetId];
	if (!asset) {
		return state;
	}

	if (shouldKeepAssetInState({state, assetId})) {
		return {
			...state,
			undoableState: {
				...state.undoableState,
				assets: {
					...state.undoableState.assets,
					[assetId]: {
						...asset,
						hiddenFromAssetLibrary: true,
					},
				},
			},
		};
	}

	const assets = {...state.undoableState.assets};
	delete assets[assetId];

	const assetStatus = {...state.assetStatus};
	delete assetStatus[assetId];

	return {
		...state,
		undoableState: {
			...state.undoableState,
			assets,
		},
		assetStatus,
	};
};
