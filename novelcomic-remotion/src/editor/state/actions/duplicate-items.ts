import {EditorStarterItem} from '../../items/item-type';
import {findSpaceForItem} from '../../utils/find-space-for-item';
import {generateRandomId} from '../../utils/generate-random-id';
import {EditorState} from '../types';
import {addItemInSpace} from './add-item';
import {isItemOnLockedTrack} from './lock-track';

export const duplicateItems = (
	state: EditorState,
	itemIds: string[],
): EditorState => {
	const duplicableItemIds = itemIds.filter((itemId) => {
		return (
			Boolean(state.undoableState.items[itemId]) &&
			!isItemOnLockedTrack(state, itemId)
		);
	});
	if (duplicableItemIds.length === 0) {
		return state;
	}

	const ids = new Array(duplicableItemIds.length)
		.fill(0)
		.map(() => generateRandomId());

	let newTracks = [...state.undoableState.tracks];
	const newItems = {...state.undoableState.items};

	for (let i = 0; i < duplicableItemIds.length; i++) {
		const itemId = duplicableItemIds[i];
		const trackIndex = state.undoableState.tracks.findIndex((track) =>
			track.items.includes(itemId),
		);

		const duplicatedItem: EditorStarterItem = {
			...state.undoableState.items[itemId],
			id: ids[i],
		};

		const space = findSpaceForItem({
			durationInFrames: duplicatedItem.durationInFrames,
			startAt: duplicatedItem.from,
			tracks: newTracks,
			startPosition: {type: 'directly-above', trackIndex},
			stopOnFirstFound: false,
			items: newItems,
		});

		newTracks = addItemInSpace({
			tracks: newTracks,
			item: duplicatedItem,
			space,
		});
		newItems[duplicatedItem.id] = duplicatedItem;
	}

	return {
		...state,
		undoableState: {
			...state.undoableState,
			tracks: newTracks,
			items: newItems,
		},
		selectedItems: ids,
	};
};
