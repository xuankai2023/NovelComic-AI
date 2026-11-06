import {describe, expect, it} from 'vitest';
import type {ImageItem} from '../../items/image/image-item-type';
import {getInitialState} from '../initial-state';
import {restoreItemsAfterCancelledDrag} from './cancel-item-drag';

const imageItem = (): ImageItem => ({
	id: 'image-1',
	type: 'image',
	assetId: 'asset-1',
	durationInFrames: 20,
	from: 0,
	top: 10,
	left: 20,
	width: 100,
	height: 100,
	opacity: 1,
	isDraggingInTimeline: false,
	borderRadius: 0,
	rotation: 0,
	keepAspectRatio: true,
	fadeInDurationInSeconds: 0,
	fadeOutDurationInSeconds: 0,
	cropLeft: 0,
	cropTop: 0,
	cropRight: 0,
	cropBottom: 0,
});

describe('restoreItemsAfterCancelledDrag', () => {
	it('restores the snapshot even when the track becomes locked during the drag', () => {
		const snapshot = imageItem();
		const state = getInitialState();
		state.undoableState = {
			...state.undoableState,
			items: {
				[snapshot.id]: {...snapshot, left: 80, top: 90},
			},
			tracks: [
				{
					id: 'track-1',
					items: [snapshot.id],
					hidden: false,
					muted: false,
					locked: true,
				},
			],
		};

		const restored = restoreItemsAfterCancelledDrag({
			state,
			snapshots: [snapshot],
		});

		expect(restored.undoableState.items[snapshot.id]).toBe(snapshot);
		expect(restored.undoableState.tracks[0]?.locked).toBe(true);
	});

	it('does not revive an item deleted during the drag', () => {
		const snapshot = imageItem();
		const state = getInitialState();
		state.undoableState = {
			...state.undoableState,
			items: {},
		};

		const restored = restoreItemsAfterCancelledDrag({
			state,
			snapshots: [snapshot],
		});

		expect(restored).toBe(state);
		expect(restored.undoableState.items[snapshot.id]).toBeUndefined();
	});
});
