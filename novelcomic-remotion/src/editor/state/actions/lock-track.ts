import {EditorState} from '../types';
import {isItemOnLockedLayerGroup} from './layer-groups';

export const isItemOnLockedTrack = (
	editorState: EditorState,
	itemId: string,
): boolean => {
	return (
		editorState.undoableState.tracks.some((track) => {
			return Boolean(track.locked) && track.items.includes(itemId);
		}) || isItemOnLockedLayerGroup(editorState.undoableState, itemId)
	);
};

export const setTrackLocked = (
	editorState: EditorState,
	trackId: string,
	locked: boolean,
): EditorState => {
	let changed = false;

	const newTracks = editorState.undoableState.tracks.map((track) => {
		if (track.id !== trackId) {
			return track;
		}

		if (Boolean(track.locked) === locked) {
			return track;
		}

		changed = true;
		return {...track, locked};
	});

	if (!changed) {
		return editorState;
	}

	return {
		...editorState,
		undoableState: {
			...editorState.undoableState,
			tracks: newTracks,
		},
	};
};
