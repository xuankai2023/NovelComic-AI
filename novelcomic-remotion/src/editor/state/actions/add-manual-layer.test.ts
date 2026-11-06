import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../../assets/assets';
import type {ImageItem} from '../../items/image/image-item-type';
import type {EditorState} from '../types';
import {addManualLayerToState} from './add-manual-layer';

const imageAsset = (id: string, width: number, height: number): ImageAsset => ({
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

const imageItem = (id: string): ImageItem => ({
	id,
	type: 'image',
	assetId: 'source',
	durationInFrames: 90,
	from: 10,
	top: 100,
	left: 60,
	width: 400,
	height: 800,
	opacity: 1,
	isDraggingInTimeline: false,
	borderRadius: 0,
	rotation: 0,
	cropLeft: 0,
	cropTop: 0,
	cropRight: 0,
	cropBottom: 0,
	keepAspectRatio: true,
	fadeInDurationInSeconds: 0,
	fadeOutDurationInSeconds: 0,
	shotId: 'shot-1',
});

const state = (): EditorState => {
	const source = imageItem('source-item');
	return {
		undoableState: {
			tracks: [
				{
					id: 'source-track',
					items: [source.id],
					hidden: false,
					muted: false,
				},
			],
			assets: {source: imageAsset('source', 1000, 2000)},
			items: {[source.id]: source},
			fps: 30,
			compositionWidth: 500,
			compositionHeight: 1000,
			deletedAssets: [],
			shots: [
				{
					id: 'shot-1',
					name: 'Shot',
					from: 0,
					durationInFrames: 90,
					layerTrackIds: ['source-track'],
					dialogueItemIds: [],
				},
			],
		},
		selectedItems: [source.id],
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

describe('addManualLayerToState', () => {
	it('places the cutout at the source image position and adds it above the source', () => {
		const result = addManualLayerToState({
			state: state(),
			sourceItem: imageItem('source-item'),
			sourceAsset: imageAsset('source', 1000, 2000),
			maskAsset: imageAsset('mask', 1000, 2000),
			cutoutAsset: imageAsset('cutout', 250, 400),
			polygon: [
				{x: 100, y: 300},
				{x: 350, y: 300},
				{x: 350, y: 700},
			],
			bounds: {x: 100, y: 300, width: 250, height: 400},
			name: 'Hair',
			semantic: 'hair',
			layerId: 'hair-layer',
		});

		const item = Object.values(result.undoableState.items).find(
			(candidate) =>
				candidate.type === 'image' && candidate.layerId === 'hair-layer',
		);
		expect(item?.type).toBe('image');
		expect(item).toMatchObject({
			left: 100,
			top: 220,
			width: 100,
			height: 160,
			assetId: 'cutout',
		});
		expect(result.undoableState.tracks.map((track) => track.id)).toEqual([
			expect.stringMatching(/^manual-track-/),
			'source-track',
		]);
		expect(result.undoableState.tracks[0]?.role).toBe('cutout');
		expect(result.undoableState.tracks[1]?.role).toBe('source');
		expect(result.undoableState.shots?.[0]?.layerTrackIds[0]).toMatch(
			/^manual-track-/,
		);
		expect(result.undoableState.comicEditLayers?.['hair-layer']).toMatchObject({
			bounds: {x: 100, y: 300, width: 250, height: 400},
			maskAssetId: 'mask',
			cutoutAssetId: 'cutout',
			sourceItemId: 'source-item',
			sourceTrackId: 'source-track',
			cutoutItemId: expect.stringMatching(/^manual-item-/),
			cutoutTrackId: expect.stringMatching(/^manual-track-/),
			cleanPlateStatus: 'missing',
			finalCompositionReady: false,
		});
	});

	it('removes the previous derived layer when replacing it', () => {
		const first = addManualLayerToState({
			state: state(),
			sourceItem: imageItem('source-item'),
			sourceAsset: imageAsset('source', 1000, 2000),
			maskAsset: imageAsset('mask-old', 1000, 2000),
			cutoutAsset: imageAsset('cutout-old', 250, 400),
			polygon: [
				{x: 100, y: 300},
				{x: 350, y: 300},
				{x: 350, y: 700},
			],
			bounds: {x: 100, y: 300, width: 250, height: 400},
			name: 'Hair',
			semantic: 'hair',
			layerId: 'hair-layer',
		});
		const second = addManualLayerToState({
			state: first,
			sourceItem: imageItem('source-item'),
			sourceAsset: imageAsset('source', 1000, 2000),
			maskAsset: imageAsset('mask-new', 1000, 2000),
			cutoutAsset: imageAsset('cutout-new', 250, 400),
			polygon: [
				{x: 120, y: 320},
				{x: 370, y: 320},
				{x: 370, y: 720},
			],
			bounds: {x: 120, y: 320, width: 250, height: 400},
			name: 'Hair',
			semantic: 'hair',
			replaceLayerId: 'hair-layer',
		});

		expect(second.undoableState.assets['mask-old']).toBeUndefined();
		expect(second.undoableState.assets['cutout-old']).toBeUndefined();
		expect(second.undoableState.assets['mask-new']).toBeDefined();
		expect(
			second.undoableState.comicEditLayers?.['hair-layer']?.maskAssetId,
		).toBe('mask-new');
		expect(
			Object.values(second.undoableState.items).filter(
				(item) => item.type === 'image' && item.layerId === 'hair-layer',
			),
		).toHaveLength(1);
	});
});
