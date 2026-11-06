import {describe, expect, it} from 'vitest';
import type {EditorState, TrackType} from '../types';
import {setTrackLocked} from './lock-track';

const track = (id: string, locked?: boolean): TrackType => {
	return {
		id,
		items: [],
		hidden: false,
		muted: false,
		...(locked === undefined ? {} : {locked}),
	};
};

const editorState = (tracks: TrackType[]): EditorState => {
	return {
		undoableState: {
			tracks,
			assets: {},
			items: {},
			fps: 30,
			compositionWidth: 1080,
			compositionHeight: 1920,
			deletedAssets: [],
		},
		selectedItems: [],
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

describe('setTrackLocked', () => {
	it('locks an unlocked track without mutating the input state', () => {
		const state = editorState([track('track-1'), track('track-2')]);
		const snapshot = structuredClone(state);

		const next = setTrackLocked(state, 'track-1', true);

		expect(state).toEqual(snapshot);
		expect(next).not.toBe(state);
		expect(next.undoableState.tracks).not.toBe(state.undoableState.tracks);
		expect(next.undoableState.tracks[0]).toEqual({
			...state.undoableState.tracks[0],
			locked: true,
		});
		expect(next.undoableState.tracks[1]).toBe(state.undoableState.tracks[1]);
	});

	it('unlocks a locked track', () => {
		const state = editorState([track('track-1', true)]);

		const next = setTrackLocked(state, 'track-1', false);

		expect(next.undoableState.tracks[0]).toMatchObject({
			id: 'track-1',
			locked: false,
		});
	});

	it('returns the same state when the requested lock state is already set', () => {
		const locked = editorState([track('track-1', true)]);
		const unlocked = editorState([track('track-1')]);

		expect(setTrackLocked(locked, 'track-1', true)).toBe(locked);
		expect(setTrackLocked(unlocked, 'track-1', false)).toBe(unlocked);
	});

	it('returns the same state when the target track does not exist', () => {
		const state = editorState([track('track-1')]);

		expect(setTrackLocked(state, 'missing-track', true)).toBe(state);
	});
});
