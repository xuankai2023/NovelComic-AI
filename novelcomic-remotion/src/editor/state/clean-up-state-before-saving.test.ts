import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import {collectAssetIdsFromItem} from '../assets/utils';
import type {ImageItem} from '../items/image/image-item-type';
import {
	cleanUpAssetStatus,
	cleanUpStateBeforeSaving,
} from './clean-up-state-before-saving';
import {getInitialState} from './initial-state';
import {normalizeUndoableState} from './normalize-undoable-state';
import type {EditorState, UndoableState} from './types';

const imageAsset = (id: string): ImageAsset => {
	return {
		id,
		type: 'image',
		filename: `${id}.png`,
		size: 1,
		remoteUrl: `https://cdn.example.com/${id}.png`,
		remoteFileKey: null,
		mimeType: 'image/png',
		width: 100,
		height: 100,
	};
};

const image = (): ImageItem => {
	return {
		id: 'face',
		type: 'image',
		assetId: 'asset-main',
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
		maskAssetId: 'asset-mask',
		maskMode: 'alpha',
		spriteAssetIds: ['asset-eye-open', 'asset-eye-closed'],
		motion: {
			spriteStates: [
				{frame: 0, assetId: 'asset-eye-open'},
				{frame: 8, assetId: 'asset-mouth-open'},
			],
		},
	};
};

const project = (): UndoableState => {
	const item = image();
	return {
		schemaVersion: 2,
		fps: 30,
		compositionWidth: 1080,
		compositionHeight: 1920,
		deletedAssets: [],
		shots: [],
		tracks: [
			{
				id: 'track-face',
				items: [item.id],
				hidden: false,
				muted: false,
			},
		],
		items: {[item.id]: item},
		assets: {
			'asset-main': imageAsset('asset-main'),
			'asset-eye-open': imageAsset('asset-eye-open'),
			'asset-eye-closed': imageAsset('asset-eye-closed'),
			'asset-mouth-open': imageAsset('asset-mouth-open'),
			'asset-mask': imageAsset('asset-mask'),
			'asset-cutout': imageAsset('asset-cutout'),
			'asset-clean': imageAsset('asset-clean'),
			'asset-unused': imageAsset('asset-unused'),
		},
		comicEditLayers: {
			'hair-1': {
				id: 'hair-1',
				name: '头发',
				semantic: 'hair',
				sourceAssetId: 'asset-main',
				sourceCanvas: {width: 100, height: 100},
				bounds: {x: 0, y: 0, width: 100, height: 100},
				maskAssetId: 'asset-mask',
				cutoutAssetId: 'asset-cutout',
				cleanPlateAssetId: 'asset-clean',
				visible: true,
				locked: false,
				opacity: 1,
				zIndex: 1,
			},
		},
	};
};

describe('cleanUpStateBeforeSaving', () => {
	it('keeps sprite and manual layer assets, then survives reload', () => {
		const source = project();
		expect(collectAssetIdsFromItem(source.items.face)).toEqual([
			'asset-main',
			'asset-mask',
			'asset-eye-open',
			'asset-eye-closed',
			'asset-mouth-open',
		]);

		const editorState: EditorState = {
			...getInitialState(),
			undoableState: source,
			assetStatus: {
				'asset-main': {type: 'uploaded'},
				'asset-eye-open': {type: 'uploaded'},
				'asset-mouth-open': {type: 'uploaded'},
				'asset-unused': {type: 'uploaded'},
			},
		};
		const cleanedStatus = cleanUpAssetStatus(editorState);
		const saved = cleanUpStateBeforeSaving(cleanedStatus.undoableState);
		const reloaded = normalizeUndoableState(
			JSON.parse(JSON.stringify(saved)) as UndoableState,
		);

		expect(Object.keys(saved.assets).sort()).toEqual([
			'asset-clean',
			'asset-cutout',
			'asset-eye-closed',
			'asset-eye-open',
			'asset-main',
			'asset-mask',
			'asset-mouth-open',
		]);
		expect(saved.assets['asset-unused']).toBeUndefined();
		expect(Object.keys(cleanedStatus.assetStatus).sort()).toEqual([
			'asset-eye-open',
			'asset-main',
			'asset-mouth-open',
		]);
		expect(Object.keys(reloaded.assets).sort()).toEqual([
			'asset-clean',
			'asset-cutout',
			'asset-eye-closed',
			'asset-eye-open',
			'asset-main',
			'asset-mask',
			'asset-mouth-open',
		]);
		expect(reloaded.items.face).toMatchObject({
			assetId: 'asset-main',
			motion: {
				spriteStates: [
					{frame: 0, assetId: 'asset-eye-open'},
					{frame: 8, assetId: 'asset-mouth-open'},
				],
			},
		});
		expect(reloaded.comicEditLayers?.['hair-1']).toMatchObject({
			maskAssetId: 'asset-mask',
			cutoutAssetId: 'asset-cutout',
			cleanPlateAssetId: 'asset-clean',
		});
	});
});
