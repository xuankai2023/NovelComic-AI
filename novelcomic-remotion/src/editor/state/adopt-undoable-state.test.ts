import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {adoptUndoableState} from './adopt-undoable-state';
import type {EditorState} from './types';

const editorState = (project = createComicProject()): EditorState => ({
	undoableState: project,
	selectedItems: ['old-item'],
	textItemEditing: 'old-item',
	textItemHoverPreview: null,
	itemSelectedForCrop: 'old-item',
	renderingTasks: [],
	captioningTasks: [],
	initialized: true,
	itemsBeingTrimmed: [],
	loop: true,
	timelineHeight: 320,
	assetStatus: {},
	isSnappingEnabled: true,
	autoKeyEnabled: false,
	activeSnapPoint: null,
	activeCanvasSnapPoints: [],
});

describe('adoptUndoableState', () => {
	it('resets editor-only selections and marks remote assets available', () => {
		const project = createComicProject();
		project.assets.remote = {
			id: 'remote',
			type: 'image',
			filename: 'remote.png',
			size: 1,
			remoteUrl: 'https://cdn.example.com/remote.png',
			remoteFileKey: null,
			mimeType: 'image/png',
			width: 10,
			height: 10,
		};

		const result = adoptUndoableState(editorState(), project);

		expect(result.undoableState).toBe(project);
		expect(result.selectedItems).toEqual([]);
		expect(result.textItemEditing).toBeNull();
		expect(result.itemSelectedForCrop).toBeNull();
		expect(result.assetStatus.remote).toEqual({type: 'uploaded'});
	});
});
