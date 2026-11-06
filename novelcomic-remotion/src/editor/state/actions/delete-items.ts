import {assertItemsDetachable} from '../../comic/shot-owned-item';
import {removeEmptyTracks} from '../../utils/remove-empty-tracks';
import {EditorState, UndoableState} from '../types';
import {isItemOnLockedTrack} from './lock-track';
import {setSelectedItems} from './set-selected-items';

export const deleteItems = (state: EditorState, idsToDelete: string[]) => {
	const deletableIds = idsToDelete.filter(
		(itemId) => !isItemOnLockedTrack(state, itemId),
	);
	if (deletableIds.length === 0) {
		return state;
	}

	assertItemsDetachable(state.undoableState, deletableIds);
	const newTracks = state.undoableState.tracks.map((track) => {
		const items = track.items.filter((itemId) => {
			if (deletableIds.includes(itemId)) {
				return false;
			}

			return true;
		});

		// Don't create a new object if no items were deleted
		if (items.length === track.items.length) {
			return track;
		}

		return {
			...track,
			items: items,
		};
	});

	const newState: UndoableState = {
		...state.undoableState,
		tracks: removeEmptyTracks(newTracks),
		items: {
			...state.undoableState.items,
		},
	};

	for (const id of deletableIds) {
		delete newState.items[id];
	}

	const newSelectedItems = state.selectedItems.filter(
		(id) => !deletableIds.includes(id),
	);

	return setSelectedItems(
		{
			...state,
			undoableState: newState,
			itemsBeingTrimmed: state.itemsBeingTrimmed.filter(
				(i) => !deletableIds.includes(i.itemId),
			),
			itemSelectedForCrop: state.itemSelectedForCrop
				? deletableIds.includes(state.itemSelectedForCrop)
					? null
					: state.itemSelectedForCrop
				: null,
		},
		newSelectedItems,
	);
};
