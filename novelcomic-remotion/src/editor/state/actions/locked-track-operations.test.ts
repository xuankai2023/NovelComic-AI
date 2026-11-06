import {describe, expect, it} from 'vitest';
import type {SolidItem} from '../../items/solid/solid-item-type';
import type {EditorState, TrackType} from '../types';
import {bringToFrontOrBack} from './bring-item-to-front-or-back';
import {changeItem} from './change-item';
import {cutItems} from './cut-items';
import {deleteItems} from './delete-items';
import {duplicateItems} from './duplicate-items';
import {isItemOnLockedTrack} from './lock-track';

const item = (id: string): SolidItem => ({
	id,
	type: 'solid',
	durationInFrames: 30,
	from: 0,
	top: 0,
	left: 0,
	width: 100,
	height: 100,
	opacity: 1,
	isDraggingInTimeline: false,
	borderRadius: 0,
	rotation: 0,
	color: '#ffffff',
	keepAspectRatio: true,
	fadeInDurationInSeconds: 0,
	fadeOutDurationInSeconds: 0,
});

const stateWithLockedItem = (): EditorState => {
	const lockedItem = item('locked-item');
	const otherItem = item('other-item');
	const lockedTrack: TrackType = {
		id: 'locked-track',
		items: [lockedItem.id],
		hidden: false,
		muted: false,
		locked: true,
	};
	const otherTrack: TrackType = {
		id: 'other-track',
		items: [otherItem.id],
		hidden: false,
		muted: false,
	};

	return {
		undoableState: {
			tracks: [lockedTrack, otherTrack],
			assets: {},
			items: {
				[lockedItem.id]: lockedItem,
				[otherItem.id]: otherItem,
			},
			fps: 30,
			compositionWidth: 1080,
			compositionHeight: 1920,
			deletedAssets: [],
		},
		selectedItems: [lockedItem.id],
		textItemEditing: null,
		textItemHoverPreview: null,
		itemSelectedForCrop: null,
		renderingTasks: [],
		captioningTasks: [],
		initialized: true,
		itemsBeingTrimmed: [],
		loop: false,
		timelineHeight: 300,
		assetStatus: {},
		isSnappingEnabled: true,
		autoKeyEnabled: false,
		activeSnapPoint: null,
		activeCanvasSnapPoints: [],
	};
};

describe('locked track operation guards', () => {
	it('identifies items on locked tracks', () => {
		const state = stateWithLockedItem();

		expect(isItemOnLockedTrack(state, 'locked-item')).toBe(true);
		expect(isItemOnLockedTrack(state, 'other-item')).toBe(false);
	});

	it('blocks canvas and inspector item changes', () => {
		const state = stateWithLockedItem();

		expect(
			changeItem(state, 'locked-item', (current) => ({
				...current,
				left: current.left + 20,
			})),
		).toBe(state);
	});

	it('blocks delete, cut, duplicate, and ordering operations', () => {
		const state = stateWithLockedItem();

		expect(deleteItems(state, ['locked-item'])).toBe(state);
		expect(cutItems(state, ['locked-item'])).toBe(state);
		expect(duplicateItems(state, ['locked-item'])).toBe(state);
		expect(
			bringToFrontOrBack({
				state,
				itemId: 'locked-item',
				position: 'back',
			}),
		).toBe(state);
	});

	it('still allows unlocked items in a mixed selection to be changed', () => {
		const state = stateWithLockedItem();
		state.selectedItems = ['locked-item', 'other-item'];

		const deleted = deleteItems(state, ['locked-item', 'other-item']);

		expect(deleted.undoableState.items['locked-item']).toBeDefined();
		expect(deleted.undoableState.items['other-item']).toBeUndefined();
		expect(deleted.selectedItems).toEqual(['locked-item']);
	});
});
