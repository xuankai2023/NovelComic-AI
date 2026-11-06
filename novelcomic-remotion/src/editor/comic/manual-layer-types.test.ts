import {describe, expect, it} from 'vitest';
import {
	cloneComicEditLayers,
	collectAssetIdsFromComicEditLayers,
	normalizeComicEditLayers,
	type ComicEditLayers,
} from './manual-layer-types';

const layer = (): ComicEditLayers => ({
	'hair-1': {
		id: 'hair-1',
		name: '前侧头发',
		semantic: 'hair',
		sourceAssetId: 'asset-source',
		shotId: 'shot-1',
		sourceCanvas: {width: 1000, height: 2000},
		bounds: {x: 120, y: 240, width: 300, height: 420},
		polygon: [
			{x: 120, y: 240},
			{x: 420, y: 240},
			{x: 420, y: 660},
			{x: 120, y: 660},
		],
		maskAssetId: 'asset-mask',
		cutoutAssetId: 'asset-cutout',
		cleanPlateAssetId: 'asset-clean',
		visible: true,
		locked: false,
		opacity: 1,
		zIndex: 10,
	},
});

describe('manual comic layer metadata', () => {
	it('normalizes valid layers and applies defaults', () => {
		const normalized = normalizeComicEditLayers({
			'hair-1': {
				...layer()['hair-1'],
				visible: undefined,
				locked: undefined,
				opacity: undefined,
				zIndex: undefined,
			},
		});

		expect(normalized?.['hair-1']).toMatchObject({
			id: 'hair-1',
			visible: true,
			locked: false,
			opacity: 1,
			zIndex: 0,
			cleanPlateStatus: 'missing',
			finalCompositionReady: false,
		});
	});

	it('preserves complete clean plate state and rejects an incomplete ready state', () => {
		const normalized = normalizeComicEditLayers({
			'hair-1': {
				...layer()['hair-1'],
				sourceItemId: 'source-item',
				sourceTrackId: 'source-track',
				cutoutItemId: 'cutout-item',
				cutoutTrackId: 'cutout-track',
				cleanPlateItemId: 'clean-item',
				cleanPlateTrackId: 'clean-track',
				cleanPlateStatus: 'ready',
				finalCompositionReady: true,
			},
		});

		expect(normalized?.['hair-1']).toMatchObject({
			cleanPlateStatus: 'ready',
			finalCompositionReady: true,
			sourceTrackId: 'source-track',
			cutoutTrackId: 'cutout-track',
			cleanPlateTrackId: 'clean-track',
		});

		expect(() =>
			normalizeComicEditLayers({
				'hair-1': {
					...layer()['hair-1'],
					cleanPlateStatus: 'ready',
					finalCompositionReady: true,
				},
			}),
		).toThrow(/final-ready without a ready clean plate/);
	});

	it('rejects invalid bounds and polygon points', () => {
		expect(() => {
			normalizeComicEditLayers({
				'hair-1': {
					...layer()['hair-1'],
					bounds: {x: 900, y: 0, width: 200, height: 100},
				},
			});
		}).toThrow(/bounds outside/);

		expect(() => {
			normalizeComicEditLayers({
				'hair-1': {
					...layer()['hair-1'],
					polygon: [
						{x: 0, y: 0},
						{x: 100, y: 0},
						{x: 100, y: 3000},
					],
				},
			});
		}).toThrow(/polygon point outside/);
	});

	it('clones nested geometry without mutating the source', () => {
		const source = layer();
		const cloned = cloneComicEditLayers(source);

		expect(cloned).not.toBe(source);
		expect(cloned?.['hair-1']).not.toBe(source['hair-1']);
		expect(cloned?.['hair-1'].bounds).not.toBe(source['hair-1'].bounds);
		expect(cloned?.['hair-1'].polygon).not.toBe(source['hair-1'].polygon);

		cloned!['hair-1'].bounds.x = 999;
		expect(source['hair-1'].bounds.x).toBe(120);
	});

	it('collects source and derived assets without duplicates', () => {
		const layers = layer();
		layers['mouth-1'] = {
			...layers['hair-1'],
			id: 'mouth-1',
			name: '嘴巴',
			semantic: 'mouth-closed',
			sourceAssetId: 'asset-source',
			maskAssetId: 'asset-mouth-mask',
			cutoutAssetId: 'asset-mouth-cutout',
			cleanPlateAssetId: undefined,
		};

		expect(collectAssetIdsFromComicEditLayers(layers)).toEqual([
			'asset-source',
			'asset-mask',
			'asset-cutout',
			'asset-clean',
			'asset-mouth-mask',
			'asset-mouth-cutout',
		]);
	});
});
