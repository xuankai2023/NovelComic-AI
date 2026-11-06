import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../../assets/assets';
import type {ImageItem} from '../../items/image/image-item-type';
import type {EditorState} from '../types';
import {
	applyCleanPlateToState,
	markCleanPlateFailed,
	restoreOriginalSourceAsset,
} from './apply-clean-plate';

const asset = (id: string, width = 100, height = 100): ImageAsset => ({
	id,
	type: 'image',
	filename: `${id}.png`,
	size: 100,
	remoteUrl: `https://cdn.example.com/${id}.png`,
	remoteFileKey: null,
	mimeType: 'image/png',
	width,
	height,
});

const sourceItem: ImageItem = {
	id: 'source-item',
	type: 'image',
	assetId: 'source',
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
	keepAspectRatio: true,
	fadeInDurationInSeconds: 0,
	fadeOutDurationInSeconds: 0,
	cropLeft: 0,
	cropTop: 0,
	cropRight: 0,
	cropBottom: 0,
	shotId: 'shot-1',
};

const state = (): EditorState => ({
	undoableState: {
		tracks: [
			{
				id: 'source-track',
				items: ['source-item'],
				hidden: false,
				muted: false,
				shotId: 'shot-1',
				role: 'source',
			},
		],
		assets: {source: asset('source')},
		items: {'source-item': sourceItem},
		fps: 30,
		compositionWidth: 100,
		compositionHeight: 100,
		deletedAssets: [],
		comicEditLayers: {
			hair: {
				id: 'hair',
				name: 'Hair',
				semantic: 'hair',
				sourceAssetId: 'source',
				sourceItemId: 'source-item',
				shotId: 'shot-1',
				sourceCanvas: {width: 100, height: 100},
				bounds: {x: 10, y: 10, width: 20, height: 20},
				polygon: [
					{x: 10, y: 10},
					{x: 30, y: 10},
					{x: 30, y: 30},
				],
				visible: true,
				locked: false,
				opacity: 1,
				zIndex: 1,
			},
		},
		shots: [
			{
				id: 'shot-1',
				name: 'Shot 1',
				from: 0,
				durationInFrames: 30,
				layerTrackIds: ['source-track'],
				dialogueItemIds: [],
			},
		],
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
});

describe('applyCleanPlateToState', () => {
	it('creates a separate clean plate item and hides L0 only after validation', () => {
		const original = state();
		const next = applyCleanPlateToState({
			state: original,
			layerId: 'hair',
			cleanPlateAsset: asset('clean'),
		});

		expect(next.undoableState.items['source-item']).toMatchObject({
			assetId: 'source',
		});
		const cleanItemId =
			next.undoableState.comicEditLayers?.hair?.cleanPlateItemId;
		const cleanTrackId =
			next.undoableState.comicEditLayers?.hair?.cleanPlateTrackId;
		expect(cleanItemId).toBeDefined();
		expect(cleanTrackId).toBeDefined();
		expect(next.undoableState.items[cleanItemId!]).toMatchObject({
			assetId: 'clean',
			left: 0,
			top: 0,
			width: 100,
			height: 100,
		});
		expect(next.undoableState.tracks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: cleanTrackId,
					role: 'clean-plate',
					items: [cleanItemId],
					hidden: false,
				}),
				expect.objectContaining({
					id: 'source-track',
					role: 'source',
					hidden: true,
				}),
			]),
		);
		expect(next.undoableState.comicEditLayers?.hair?.cleanPlateAssetId).toBe(
			'clean',
		);
		expect(next.undoableState.comicEditLayers?.hair?.cleanPlateStatus).toBe(
			'ready',
		);
		expect(
			next.undoableState.comicEditLayers?.hair?.finalCompositionReady,
		).toBe(true);
		expect(next.undoableState.assets.source).toBeDefined();
		expect(original.undoableState.items['source-item']).toMatchObject({
			assetId: 'source',
		});
	});

	it('rejects a clean plate with mismatched dimensions without changing state', () => {
		const original = state();
		expect(() =>
			applyCleanPlateToState({
				state: original,
				layerId: 'hair',
				cleanPlateAsset: asset('bad-clean', 99, 100),
			}),
		).toThrow(/dimensions must match/);
		expect(original.undoableState.items['source-item']?.type).toBe('image');
		expect(
			(original.undoableState.items['source-item'] as ImageItem).assetId,
		).toBe('source');
	});

	it('restores the original L0 asset without deleting the clean plate asset', () => {
		const applied = applyCleanPlateToState({
			state: state(),
			layerId: 'hair',
			cleanPlateAsset: asset('clean'),
		});
		const restored = restoreOriginalSourceAsset(applied, 'hair');

		expect(
			(restored.undoableState.items['source-item'] as ImageItem).assetId,
		).toBe('source');
		expect(restored.undoableState.assets.clean).toBeDefined();
		expect(
			restored.undoableState.comicEditLayers?.hair?.cleanPlateAssetId,
		).toBeUndefined();
		expect(restored.undoableState.tracks).toHaveLength(1);
		expect(restored.undoableState.tracks[0]).toMatchObject({
			id: 'source-track',
			hidden: false,
		});
	});

	it('keeps L0 visible and records a failed status when clean plate generation fails', () => {
		const applied = applyCleanPlateToState({
			state: state(),
			layerId: 'hair',
			cleanPlateAsset: asset('clean'),
		});
		const failed = markCleanPlateFailed(applied, 'hair');

		expect(failed.undoableState.tracks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({id: 'source-track', hidden: false}),
				expect.objectContaining({
					role: 'clean-plate',
					hidden: true,
				}),
			]),
		);
		expect(failed.undoableState.comicEditLayers?.hair).toMatchObject({
			cleanPlateStatus: 'failed',
			finalCompositionReady: false,
		});
	});
});
