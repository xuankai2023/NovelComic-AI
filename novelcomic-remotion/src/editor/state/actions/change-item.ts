import {EditorStarterItem} from '../../items/item-type';
import {writeItemTransformPropertySet} from '../../property/materialize-motion';
import {EditorState} from '../types';
import {isItemOnLockedTrack} from './lock-track';

export const changeItem = (
	state: EditorState,
	itemId: string,
	updater: (item: EditorStarterItem) => EditorStarterItem,
): EditorState => {
	let updated = false;
	const existingItem = state.undoableState.items[itemId];
	if (!existingItem || isItemOnLockedTrack(state, itemId)) {
		return state;
	}

	const updatedItem = updater(existingItem);
	if (updatedItem !== existingItem) {
		updated = true;
	}

	if (updated) {
		const undoableState = {
			...state.undoableState,
			items: {
				...state.undoableState.items,
				[itemId]: updatedItem,
			},
		};
		const newState = {
			...state,
			undoableState:
				updatedItem.type === 'image'
					? writeItemTransformPropertySet(
							undoableState,
							itemId,
							updatedItem.motion?.transform,
						)
					: undoableState,
		};

		return newState;
	}
	return state;
};
