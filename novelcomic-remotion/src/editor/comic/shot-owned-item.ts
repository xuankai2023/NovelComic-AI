import type {EditorStarterItem} from '../items/item-type';
import type {UndoableState} from '../state/types';
import {domainInvariant} from './errors';

export const SHOT_TIMING_LOCK_MESSAGE =
	'Shot-owned items cannot be trimmed independently; use editShot or deleteShot';

export const hasShotTimingLock = (item: EditorStarterItem): boolean => {
	if (item.type === 'image' && (item.shotId || item.layerId)) {
		return true;
	}

	return item.type === 'captions' && item.id.startsWith('dialogue:');
};

export const isShotOwnedItem = (
	project: UndoableState,
	itemId: string,
): boolean => {
	const item = project.items[itemId];
	if (item && hasShotTimingLock(item)) {
		return true;
	}

	for (const shot of project.shots ?? []) {
		if (shot.dialogueItemIds.includes(itemId)) {
			return true;
		}

		if (
			shot.layerTrackIds.some((trackId) => {
				return project.tracks.some((track) => {
					return track.id === trackId && track.items.includes(itemId);
				});
			})
		) {
			return true;
		}
	}

	return project.tracks.some((track) => {
		return Boolean(track.shotId) && track.items.includes(itemId);
	});
};

const shotIdForItem = (
	project: UndoableState,
	itemId: string,
): string | undefined => {
	const item = project.items[itemId];
	if (item?.type === 'image' && item.shotId) {
		return item.shotId;
	}

	return project.tracks.find((track) => {
		return track.items.includes(itemId);
	})?.shotId;
};

export const assertShotTimingUnlocked = (item: EditorStarterItem): void => {
	if (!hasShotTimingLock(item)) {
		return;
	}

	throw domainInvariant(SHOT_TIMING_LOCK_MESSAGE, {
		itemId: item.id,
		shotId: item.type === 'image' ? item.shotId : undefined,
	});
};

export const assertItemsDetachable = (
	project: UndoableState,
	itemIds: readonly string[],
): void => {
	for (const itemId of itemIds) {
		if (!isShotOwnedItem(project, itemId)) {
			continue;
		}

		throw domainInvariant(SHOT_TIMING_LOCK_MESSAGE, {
			itemId,
			shotId: shotIdForItem(project, itemId),
		});
	}
};
