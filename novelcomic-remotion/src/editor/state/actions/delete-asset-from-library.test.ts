import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../../assets/assets';
import {getInitialState} from '../initial-state';
import {deleteAssetFromLibrary} from './delete-asset-from-library';

const asset = (id: string): ImageAsset => ({
	id,
	type: 'image',
	filename: `${id}.png`,
	size: 1,
	remoteUrl: `https://cdn.example.com/${id}.png`,
	remoteFileKey: null,
	mimeType: 'image/png',
	width: 100,
	height: 100,
});

describe('deleteAssetFromLibrary', () => {
	it('keeps an L0 source asset referenced only by comic layer metadata', () => {
		const state = getInitialState();
		state.undoableState = {
			...state.undoableState,
			assets: {
				source: asset('source'),
			},
			comicEditLayers: {
				hair: {
					id: 'hair',
					name: 'Hair',
					semantic: 'hair',
					sourceAssetId: 'source',
					sourceCanvas: {width: 100, height: 100},
					bounds: {x: 0, y: 0, width: 10, height: 10},
					visible: true,
					locked: false,
					opacity: 1,
					zIndex: 1,
				},
			},
		};
		state.assetStatus = {
			source: {type: 'uploaded'},
		};

		const next = deleteAssetFromLibrary(state, 'source');

		expect(next.undoableState.assets.source).toMatchObject({
			hiddenFromAssetLibrary: true,
		});
		expect(next.assetStatus.source).toEqual({type: 'uploaded'});
	});
});
