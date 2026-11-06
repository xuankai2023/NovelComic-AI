import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import type {ImageItem} from '../items/image/image-item-type';
import {deleteItems} from '../state/actions/delete-items';
import {splitItem} from '../state/actions/split-item';
import {updateItemTimings} from '../state/actions/update-item-timings';
import type {EditorState} from '../state/types';
import {SHOT_TIMING_LOCK_MESSAGE} from './shot-owned-item';
import {upsertShot} from './upsert-shot';

const image = (id: string, shotId?: string): ImageItem => {
	return {
		id,
		type: 'image',
		assetId: `${id}-asset`,
		durationInFrames: 40,
		from: 0,
		top: 0,
		left: 0,
		width: 10,
		height: 10,
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
		shotId,
		layerId: shotId ? id : undefined,
	};
};

const editorState = (
	project: ReturnType<typeof createComicProject>,
): EditorState => {
	return {
		undoableState: project,
		selectedItems: [],
		textItemEditing: null,
		textItemHoverPreview: null,
		itemSelectedForCrop: null,
		renderingTasks: [],
		captioningTasks: [],
		initialized: true,
		itemsBeingTrimmed: [],
		loop: false,
		timelineHeight: 200,
		assetStatus: {},
		isSnappingEnabled: false,
		autoKeyEnabled: false,
		activeSnapPoint: null,
		activeCanvasSnapPoints: [],
	};
};

describe('shot-owned timeline locks', () => {
	it('blocks trim, split, and delete for shot items and still edits plain items', () => {
		const plain = image('plain');
		const owned = image('owned', 'shot-1');
		let project = upsertShot(createComicProject(), {
			shotId: 'shot-1',
			durationInFrames: 40,
		});
		project = {
			...project,
			items: {[plain.id]: plain, [owned.id]: owned},
			tracks: [
				{
					id: 'track-plain',
					items: [plain.id],
					hidden: false,
					muted: false,
				},
				{
					id: 'track-owned',
					items: [owned.id],
					hidden: false,
					muted: false,
					shotId: 'shot-1',
					semantic: 'body',
				},
			],
			shots: project.shots?.map((shot) => {
				return {...shot, layerTrackIds: ['track-owned']};
			}),
		};
		const state = editorState(project);

		expect(
			updateItemTimings({
				item: plain,
				newFrom: 4,
				newDurationInFrames: 20,
			}),
		).toMatchObject({from: 4, durationInFrames: 20});
		expect(() => {
			updateItemTimings({
				item: owned,
				newFrom: 4,
				newDurationInFrames: 20,
			});
		}).toThrow(SHOT_TIMING_LOCK_MESSAGE);
		expect(() => {
			splitItem({state, idToSplit: owned.id, framePosition: 10});
		}).toThrow(SHOT_TIMING_LOCK_MESSAGE);
		expect(() => deleteItems(state, [owned.id])).toThrow(
			SHOT_TIMING_LOCK_MESSAGE,
		);
		expect(state.undoableState.items[owned.id]).toBe(owned);

		const deleted = deleteItems(state, [plain.id]);
		expect(deleted.undoableState.items[plain.id]).toBeUndefined();
		expect(deleted.undoableState.items[owned.id]).toBe(owned);
	});
});
