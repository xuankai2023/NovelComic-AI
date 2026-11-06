import {removeEmptyTracks} from '../../utils/remove-empty-tracks';
import {EditorState, UndoableState} from '../types';
import {isItemOnLockedTrack} from './lock-track';
import {setSelectedItems} from './set-selected-items';

export const cutItems = (state: EditorState, idsToCut: string[]) => {
	const cuttableIds = idsToCut.filter(
		(itemId) => !isItemOnLockedTrack(state, itemId),
	);
	if (cuttableIds.length === 0) {
		return state;
	}

	const newTracks = state.undoableState.tracks.map((track) => {
		const items = track.items.filter((itemId) => {
			if (cuttableIds.includes(itemId)) {
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

	for (const id of cuttableIds) {
		delete newState.items[id];
	}

	const newSelectedItems = state.selectedItems.filter(
		(id) => !cuttableIds.includes(id),
	);

	return setSelectedItems(
		{
			...state,
			undoableState: newState,
		},
		newSelectedItems,
	);
};
