import {collectAssetIdsFromItem} from '../assets/utils';
import type {EditorStarterItem} from '../items/item-type';
import type {UndoableState} from '../state/types';
import {domainInvariant} from './errors';
import {applyShotTiming, cloneUndoableState, reflowShots} from './upsert-shot';

const withoutItems = (
	items: Record<string, EditorStarterItem>,
	removed: ReadonlySet<string>,
): Record<string, EditorStarterItem> => {
	let next = items;
	for (const itemId of removed) {
		if (!(itemId in next)) {
			continue;
		}

		if (next === items) {
			next = {...items};
		}

		delete next[itemId];
	}

	return next;
};

export const deleteShot = (
	project: UndoableState,
	shotId: string,
): UndoableState => {
	const shots = project.shots ?? [];
	const index = shots.findIndex((shot) => {
		return shot.id === shotId;
	});
	if (index === -1) {
		throw domainInvariant(`Shot ${shotId} does not exist`, {shotId});
	}

	const removedShot = shots[index];
	const removedItemIds = new Set<string>(removedShot.dialogueItemIds);
	for (const track of project.tracks) {
		if (
			track.shotId === shotId ||
			removedShot.layerTrackIds.includes(track.id)
		) {
			for (const itemId of track.items) {
				removedItemIds.add(itemId);
			}
		}
	}

	for (const item of Object.values(project.items)) {
		if (item.type === 'image' && item.shotId === shotId) {
			removedItemIds.add(item.id);
		}
	}

	const removedAssetIds = new Set<string>();
	for (const itemId of removedItemIds) {
		const item = project.items[itemId];
		if (!item) {
			continue;
		}

		for (const assetId of collectAssetIdsFromItem(item)) {
			removedAssetIds.add(assetId);
		}
	}

	const draft = cloneUndoableState(project);
	const items = withoutItems(draft.items, removedItemIds);
	const stillUsed = new Set<string>();
	for (const item of Object.values(items)) {
		for (const assetId of collectAssetIdsFromItem(item)) {
			stillUsed.add(assetId);
		}
	}

	const assets = {...draft.assets};
	for (const assetId of removedAssetIds) {
		if (!stillUsed.has(assetId)) {
			delete assets[assetId];
		}
	}

	const tracks = draft.tracks
		.filter((track) => {
			return (
				track.shotId !== shotId && !removedShot.layerTrackIds.includes(track.id)
			);
		})
		.map((track) => {
			const kept = track.items.filter((itemId) => {
				return !removedItemIds.has(itemId);
			});
			if (kept.length === track.items.length) {
				return track;
			}

			return {
				...track,
				items: kept,
			};
		})
		.filter((track) => {
			return track.items.length > 0;
		});

	let remaining = shots.filter((shot) => {
		return shot.id !== shotId;
	});
	if (index === 0 && remaining[0]) {
		remaining = [
			{
				...remaining[0],
				from: removedShot.from,
			},
			...remaining.slice(1),
		];
	}

	const previous = new Map(
		shots.map((shot) => {
			return [shot.id, shot] as const;
		}),
	);
	return applyShotTiming(
		{
			...draft,
			tracks,
			items,
			assets,
		},
		previous,
		reflowShots(remaining),
	);
};
