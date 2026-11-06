import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import {COMIC_ERROR_CODES, ComicEditorError} from '../comic/errors';
import {COMIC_SCHEMA_VERSION} from '../comic/limits';
import type {Shot} from '../comic/types';
import type {CaptionsItem} from '../items/captions/captions-item-type';
import type {ImageItem} from '../items/image/image-item-type';
import {normalizeUndoableState} from './normalize-undoable-state';
import type {TrackType, UndoableState} from './types';

const imageItem = (): ImageItem => {
	return {
		id: 'image-1',
		type: 'image',
		assetId: 'asset-1',
		durationInFrames: 90,
		from: 0,
		top: 0,
		left: 0,
		width: 1080,
		height: 1920,
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
	};
};

const captionItem = (): CaptionsItem => {
	return {
		id: 'caption-1',
		type: 'captions',
		assetId: 'asset-caption',
		durationInFrames: 90,
		from: 0,
		top: 1400,
		left: 54,
		width: 972,
		height: 80,
		opacity: 1,
		isDraggingInTimeline: false,
		rotation: 0,
		captionStyle: 'broken' as CaptionsItem['captionStyle'],
		fontFamily: 'TikTok Sans',
		fontStyle: {variant: 'normal', weight: '600'},
		lineHeight: 1.2,
		letterSpacing: 0,
		fontSize: 32,
		align: 'center',
		color: 'white',
		highlightColor: '#39E508',
		strokeWidth: 4,
		strokeColor: 'black',
		direction: 'ltr',
		pageDurationInMilliseconds: 2000,
		captionStartInSeconds: 0,
		maxLines: 2,
		fadeInDurationInSeconds: 0,
		fadeOutDurationInSeconds: 0,
	};
};

const legacyProject = (): UndoableState => {
	const image = imageItem();
	return {
		tracks: [
			{
				id: 'track-1',
				items: [image.id],
				hidden: false,
				muted: false,
			},
		],
		assets: {},
		items: {
			[image.id]: image,
		},
		fps: 30,
		compositionWidth: 1080,
		compositionHeight: 1920,
		deletedAssets: [],
	};
};

const shot = (): Shot => {
	return {
		id: 'shot-1',
		name: '开场',
		from: 0,
		durationInFrames: 90,
		layerTrackIds: ['track-1'],
		dialogueItemIds: [],
	};
};

const imageAsset = (id: string, width: number, height: number): ImageAsset => ({
	id,
	type: 'image',
	filename: `${id}.png`,
	size: 1,
	remoteUrl: `https://cdn.example.com/${id}.png`,
	remoteFileKey: null,
	mimeType: 'image/png',
	width,
	height,
});

describe('normalizeUndoableState', () => {
	it('normalizes manual comic layer metadata without mutating the input', () => {
		const project = legacyProject();
		project.schemaVersion = COMIC_SCHEMA_VERSION;
		project.comicEditLayers = {
			'hair-1': {
				id: 'hair-1',
				name: '头发',
				semantic: 'hair',
				sourceAssetId: 'asset-1',
				sourceCanvas: {width: 1080, height: 1920},
				bounds: {x: 10, y: 20, width: 100, height: 200},
				polygon: [
					{x: 10, y: 20},
					{x: 110, y: 20},
					{x: 110, y: 220},
				],
				visible: true,
				locked: false,
				opacity: 1,
				zIndex: 2,
			},
		};
		const snapshot = structuredClone(project);

		const normalized = normalizeUndoableState(project);

		expect(project).toEqual(snapshot);
		expect(normalized.comicEditLayers).not.toBe(project.comicEditLayers);
		expect(normalized.comicEditLayers?.['hair-1']).toMatchObject({
			cleanPlateStatus: 'missing',
			finalCompositionReady: false,
		});
	});

	it('rejects invalid manual comic layer metadata', () => {
		const project = legacyProject();
		project.schemaVersion = COMIC_SCHEMA_VERSION;
		project.comicEditLayers = {
			'hair-1': {
				id: 'hair-1',
				name: '头发',
				semantic: 'hair',
				sourceAssetId: 'asset-1',
				sourceCanvas: {width: 1080, height: 1920},
				bounds: {x: 1000, y: 20, width: 200, height: 200},
				visible: true,
				locked: false,
				opacity: 1,
				zIndex: 2,
			},
		};

		expect(() => normalizeUndoableState(project)).toThrow(
			/bounds outside its source canvas/,
		);
	});

	it('rejects a clean plate whose dimensions do not match the source canvas', () => {
		const project = legacyProject();
		project.schemaVersion = COMIC_SCHEMA_VERSION;
		project.assets = {
			'asset-clean': imageAsset('asset-clean', 100, 100),
		};
		project.comicEditLayers = {
			'hair-1': {
				id: 'hair-1',
				name: '头发',
				semantic: 'hair',
				sourceAssetId: 'asset-source',
				sourceCanvas: {width: 1080, height: 1920},
				bounds: {x: 10, y: 20, width: 100, height: 200},
				cleanPlateAssetId: 'asset-clean',
				visible: true,
				locked: false,
				opacity: 1,
				zIndex: 2,
			},
		};

		expect(() => normalizeUndoableState(project)).toThrow(
			/clean plate dimensions do not match/,
		);
	});

	it('requires referenced source, cutout, and clean plate tracks to contain their items', () => {
		const project = legacyProject();
		project.schemaVersion = COMIC_SCHEMA_VERSION;
		const cutout = {...imageItem(), id: 'cutout-item', assetId: 'asset-cutout'};
		const clean = {...imageItem(), id: 'clean-item', assetId: 'asset-clean'};
		project.items = {
			'image-1': imageItem(),
			[cutout.id]: cutout,
			[clean.id]: clean,
		};
		project.assets = {
			'asset-1': imageAsset('asset-1', 1080, 1920),
			'asset-cutout': imageAsset('asset-cutout', 100, 200),
			'asset-clean': imageAsset('asset-clean', 1080, 1920),
		};
		project.tracks = [
			{
				id: 'source-track',
				items: ['image-1'],
				hidden: false,
				muted: false,
				role: 'source',
			},
			{
				id: 'cutout-track',
				items: ['cutout-item'],
				hidden: false,
				muted: false,
				role: 'cutout',
			},
			{
				id: 'clean-track',
				items: ['wrong-item'],
				hidden: false,
				muted: false,
				role: 'clean-plate',
			},
		];
		project.comicEditLayers = {
			'hair-1': {
				id: 'hair-1',
				name: '头发',
				semantic: 'hair',
				sourceAssetId: 'asset-1',
				sourceItemId: 'image-1',
				sourceTrackId: 'source-track',
				sourceCanvas: {width: 1080, height: 1920},
				bounds: {x: 10, y: 20, width: 100, height: 200},
				cutoutAssetId: 'asset-cutout',
				cutoutItemId: 'cutout-item',
				cutoutTrackId: 'cutout-track',
				cleanPlateAssetId: 'asset-clean',
				cleanPlateItemId: 'clean-item',
				cleanPlateTrackId: 'clean-track',
				cleanPlateStatus: 'ready',
				finalCompositionReady: true,
				visible: true,
				locked: false,
				opacity: 1,
				zIndex: 2,
			},
		};

		expect(() => normalizeUndoableState(project)).toThrow(
			/does not contain item clean-item/,
		);
	});

	it('treats a v1 project as legacy and fills shots in memory', () => {
		const project = legacyProject();
		const snapshot = structuredClone(project);

		const normalized = normalizeUndoableState(project);

		expect(project).toEqual(snapshot);
		expect(normalized).not.toBe(project);
		expect(normalized.schemaVersion).toBe(COMIC_SCHEMA_VERSION);
		expect(normalized.propertyGraph?.version).toBe(1);
		expect(normalized.propertyGraph?.sets['item:image-1']).toBeDefined();
		expect(normalized.shots).toEqual([]);
		expect(normalized.items).toBe(project.items);
		expect(normalized.tracks).toBe(project.tracks);
	});

	it('fills a missing PropertyGraph on a schema 3 project', () => {
		const project = legacyProject();
		project.schemaVersion = COMIC_SCHEMA_VERSION;
		project.shots = [shot()];

		const normalized = normalizeUndoableState(project);
		expect(normalized).not.toBe(project);
		expect(normalized.schemaVersion).toBe(COMIC_SCHEMA_VERSION);
		expect(normalized.propertyGraph?.sets['shot:shot-1']).toBeDefined();
	});

	it('fills empty optional fields without inventing motion or track semantics', () => {
		const project = legacyProject();
		project.schemaVersion = COMIC_SCHEMA_VERSION;
		const track = project.tracks[0] as TrackType;
		const image = project.items['image-1'] as ImageItem;

		const normalized = normalizeUndoableState(project);

		expect(normalized.shots).toEqual([]);
		expect(normalized.schemaVersion).toBe(COMIC_SCHEMA_VERSION);
		expect(track.name).toBeUndefined();
		expect(track.shotId).toBeUndefined();
		expect(track.semantic).toBeUndefined();
		expect(image.motion).toBeUndefined();
		expect(image.shotId).toBeUndefined();
		expect(image.layerId).toBeUndefined();
		expect(normalized.items['image-1']).toBe(image);
	});

	it('rejects a future schema version and leaves the input unchanged', () => {
		const project = legacyProject();
		project.schemaVersion = COMIC_SCHEMA_VERSION + 1;
		const snapshot = structuredClone(project);

		expect(() => normalizeUndoableState(project)).toThrow(ComicEditorError);
		expect(project).toEqual(snapshot);

		try {
			normalizeUndoableState(project);
		} catch (error) {
			expect(error).toMatchObject({
				code: COMIC_ERROR_CODES.SCHEMA_TOO_NEW,
				retryable: false,
				status: 422,
			});
			expect(error).toBeInstanceOf(ComicEditorError);
		}
	});

	it('normalizes legacy items without mutating the original project', () => {
		const project = legacyProject();
		const caption = captionItem();
		project.items = {
			...project.items,
			[caption.id]: caption,
		};
		const snapshot = structuredClone(project);

		const normalized = normalizeUndoableState(project);
		const normalizedCaption = normalized.items[caption.id] as CaptionsItem;

		expect(project).toEqual(snapshot);
		expect(project.items[caption.id]).toBe(caption);
		expect(caption.captionStyle).toBe('broken');
		expect(normalizedCaption).not.toBe(caption);
		expect(normalizedCaption.captionStyle).toBe('default');
		expect(normalized.shots).toEqual([]);
		expect(normalized.items['image-1']).toBe(project.items['image-1']);
	});
});
