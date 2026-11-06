import type {EditorStarterItem} from '../items/item-type';
import type {UndoableState} from '../state/types';
import {domainInvariant} from './errors';

export const assertFinalMotionTarget = (
	project: UndoableState,
	item: EditorStarterItem,
): void => {
	const track = project.tracks.find((candidate) =>
		candidate.items.includes(item.id),
	);
	if (track?.role === 'source') {
		throw domainInvariant('L0 source items cannot receive final animation', {
			itemId: item.id,
		});
	}
};
