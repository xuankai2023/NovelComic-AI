import {describe, expect, it} from 'vitest';
import {createEmptyDocument, createGroupLayer, createPixelLayer} from '../../document/defaults';
import type {AssetRecord, DocumentState} from '../../document/types';
import {createPixelBuffer} from '../../pixels/pixel-tools';
import {sampleWandImage} from './wand-sample';

const asset = (id: string): AssetRecord => ({
	id,
	kind: 'raster',
	originalName: id,
	mimeType: 'image/png',
	width: 4,
	height: 2,
	byteSize: 32,
	objectKey: `memory://${id}`,
	contentHash: id,
});

const documentWith = (layerId: string, kind: 'pixel' | 'group'): DocumentState => {
	const document = createEmptyDocument({width: 4, height: 2, projectId: 'p'});
	const layer = kind === 'group' ? createGroupLayer('Group') : createPixelLayer('pixels', 'Pixels', 4, 2);
	layer.id = layerId;
	document.layers[layerId] = layer;
	document.rootLayerIds = [layerId];
	if (kind === 'pixel') document.assets.pixels = asset('pixels');
	return document;
};

describe('wand sample', () => {
	it('reads a blank or group layer as transparent and copies an upright pixel layer', () => {
		const blank = documentWith('layer', 'group');
		const transparent = sampleWandImage(blank, 'layer', false, () => null, null);
		expect(transparent?.data.every((value) => value === 0)).toBe(true);
		const pixels = createPixelBuffer(4, 2, [255, 0, 0, 128]);
		const placed = sampleWandImage(documentWith('layer', 'pixel'), 'layer', false, () => pixels, null);
		expect(placed?.data[0]).toBe(Math.floor((255 * 128 + 127) / 255));
		expect(placed?.data[3]).toBe(128);
	});

	it('uses the supplied composite when sampling every layer', () => {
		const composite = createPixelBuffer(4, 2, [0, 0, 255, 255]);
		const sampled = sampleWandImage(documentWith('layer', 'pixel'), 'layer', true, () => null, composite);
		expect(sampled?.data[2]).toBe(255);
		expect(sampled?.data[0]).toBe(0);
	});
});
