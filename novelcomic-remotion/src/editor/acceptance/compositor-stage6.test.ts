import {describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../commands/document-command-history';
import {createDocumentCommand} from '../commands/document-command-types';
import {
	createEmptyDocument,
	createGroupLayer,
	createPixelLayer,
} from '../document';
import {
	applyMaskStroke,
	createMaskSurface,
	createMaskTileDiff,
} from '../pixels/mask-pixel-core';
import {evaluateDocumentFrame} from '../render-graph/evaluate-document-frame';

const raster = {
	id: 'raster',
	kind: 'raster' as const,
	originalName: 'raster.png',
	mimeType: 'image/png',
	width: 16,
	height: 16,
	byteSize: 1024,
	objectKey: 'data:image/png;base64,raster',
	contentHash: 'raster',
};
const mask = {
	id: 'mask',
	kind: 'mask' as const,
	originalName: 'mask.png',
	mimeType: 'image/png',
	width: 16,
	height: 16,
	byteSize: 256,
	objectKey: 'data:image/png;base64,mask',
	contentHash: 'mask',
};

describe('Compositor stage 6: mask and pixel worker', () => {
	it('preserves white, black and gray mask semantics', () => {
		const surface = createMaskSurface(3, 1, 128);
		const painted = applyMaskStroke(
			surface,
			[{x: 0.5, y: 0.5}],
			{size: 1, hardness: 1, opacity: 1},
			'paint',
		);
		const erased = applyMaskStroke(
			painted,
			[{x: 2.5, y: 0.5}],
			{size: 1, hardness: 1, opacity: 1},
			'erase',
		);
		expect([...erased.alpha]).toEqual([255, 128, 0]);
	});

	it('stores only changed tiles for history compression', () => {
		const before = createMaskSurface(256, 256, 255);
		const after = applyMaskStroke(
			before,
			[{x: 10, y: 10}],
			{size: 8, hardness: 1, opacity: 1},
			'erase',
		);
		const diff = createMaskTileDiff(before, after, 64);
		expect(diff.tiles).toHaveLength(1);
		expect(diff.byteLength).toBeLessThan(before.alpha.byteLength / 4);
	});

	it('attaches, unlinks, removes and undoes a normal mask through commands', () => {
		const document = createEmptyDocument({projectId: 'project'});
		document.assets[raster.id] = raster;
		const layer = createPixelLayer(raster.id, 'Pixel', 16, 16);
		layer.id = 'pixel';
		document.layers[layer.id] = layer;
		document.rootLayerIds = [layer.id];
		const history = new DocumentCommandHistory();
		let current = history.execute(
			document,
			createDocumentCommand({
				type: 'mask.attach',
				projectId: document.projectId,
				payload: {
					layerId: layer.id,
					asset: mask,
					mask: {
						assetId: mask.id,
						enabled: true,
						linkedToLayer: true,
						invert: false,
						feather: 0,
					},
				},
			}),
		);
		current = history.execute(
			current,
			createDocumentCommand({
				type: 'mask.update',
				projectId: document.projectId,
				payload: {
					layerId: layer.id,
					changes: {
						linkedToLayer: false,
						placement: {...layer.transform, originX: 7},
					},
				},
			}),
		);
		expect(current.layers[layer.id].mask?.linkedToLayer).toBe(false);
		expect(current.layers[layer.id].mask?.placement?.originX).toBe(7);
		current = history.execute(
			current,
			createDocumentCommand({
				type: 'mask.remove',
				projectId: document.projectId,
				payload: {layerId: layer.id, removeAsset: true},
			}),
		);
		expect(current.layers[layer.id].mask).toBeUndefined();
		current = history.undo(current);
		expect(current.layers[layer.id].mask?.assetId).toBe(mask.id);
		current = history.undo(current);
		expect(current.layers[layer.id].mask?.linkedToLayer).toBe(true);
	});

	it('propagates folder masks and keeps live masks in the evaluated graph', () => {
		const document = createEmptyDocument({projectId: 'project'});
		document.assets[raster.id] = raster;
		document.assets[mask.id] = mask;
		const group = createGroupLayer('Folder');
		group.id = 'folder';
		group.mask = {
			assetId: mask.id,
			enabled: true,
			linkedToLayer: true,
			invert: false,
			feather: 2,
		};
		const source = createPixelLayer(raster.id, 'Source', 16, 16);
		source.id = 'source';
		source.parentId = group.id;
		const target = createPixelLayer(raster.id, 'Target', 16, 16);
		target.id = 'target';
		target.parentId = group.id;
		target.order = 1;
		target.liveMask = {sourceLayerId: source.id, mode: 'alpha'};
		document.layers = {
			[group.id]: group,
			[source.id]: source,
			[target.id]: target,
		};
		document.rootLayerIds = [group.id];
		const frame = evaluateDocumentFrame({document});
		const evaluated = frame.layers.find((entry) => entry.id === target.id);
		expect(
			evaluated?.effectiveMasks.map((entry) => entry.mask.assetId),
		).toEqual([mask.id]);
		expect(evaluated?.liveMask).toEqual({
			sourceLayerId: source.id,
			mode: 'alpha',
		});
	});

	it('applies a raster result and restores the original layer on undo', () => {
		const document = createEmptyDocument({projectId: 'project'});
		document.assets[raster.id] = raster;
		document.assets[mask.id] = mask;
		const layer = createPixelLayer(raster.id, 'Pixel', 16, 16);
		layer.id = 'pixel';
		layer.mask = {
			assetId: mask.id,
			enabled: true,
			linkedToLayer: true,
			invert: false,
			feather: 0,
		};
		document.layers[layer.id] = layer;
		document.rootLayerIds = [layer.id];
		const applied = {
			...raster,
			id: 'applied',
			originalName: 'applied.png',
			contentHash: 'applied',
		};
		const history = new DocumentCommandHistory();
		let current = history.execute(
			document,
			createDocumentCommand({
				type: 'mask.apply',
				projectId: document.projectId,
				payload: {layerId: layer.id, asset: applied},
			}),
		);
		expect(current.layers[layer.id].content).toEqual({
			kind: 'pixel',
			assetId: applied.id,
		});
		expect(current.layers[layer.id].mask).toBeUndefined();
		current = history.undo(current);
		expect(current.layers[layer.id].content).toEqual({
			kind: 'pixel',
			assetId: raster.id,
		});
		expect(current.layers[layer.id].mask?.assetId).toBe(mask.id);
	});
});
