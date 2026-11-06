import type {EditorStarterItem} from '../../items/item-type';
import type {EditorState} from '../types';

export const restoreItemsAfterCancelledDrag = ({
	state,
	snapshots,
}: {
	state: EditorState;
	snapshots: readonly EditorStarterItem[];
}): EditorState => {
	let items = state.undoableState.items;

	for (const snapshot of snapshots) {
		const currentItem = items[snapshot.id];
		if (!currentItem || currentItem === snapshot) {
			continue;
		}
		items = {...items, [snapshot.id]: snapshot};
	}

	if (items === state.undoableState.items) {
		return state;
	}

	return {
		...state,
		undoableState: {
			...state.undoableState,
			items,
		},
	};
};
