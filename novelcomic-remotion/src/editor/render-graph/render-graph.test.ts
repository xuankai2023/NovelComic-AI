import {describe, expect, it} from 'vitest';
import {createEmptyDocument, createGroupLayer, createPixelLayer} from '../document';
import {buildRenderGraph} from './build-render-graph';
import {evaluateDocumentFrame} from './evaluate-document-frame';

const asset = {
	id: 'asset-1',
	kind: 'raster' as const,
	originalName: 'pixel.png',
	mimeType: 'image/png',
	width: 10,
	height: 10,
	byteSize: 4,
	objectKey: 'pixel.png',
	contentHash: 'hash',
};

describe('compositor render graph', () => {
	it('flattens nested groups and accumulates transform and opacity', () => {
		const document = createEmptyDocument({documentId: 'd'});
		document.assets[asset.id] = asset;
		const group = createGroupLayer('Group');
		group.id = 'group';
		group.opacity = 0.5;
		group.transform.originX = 10;
		group.transform.originY = 20;
		const pixel = createPixelLayer(asset.id, 'Pixel', 10, 10);
		pixel.id = 'pixel';
		pixel.parentId = group.id;
		pixel.order = 0;
		pixel.opacity = 0.8;
		pixel.transform.originX = 4;
		pixel.transform.originY = 6;
		document.layers[group.id] = group;
		document.layers[pixel.id] = pixel;
		document.rootLayerIds = [group.id];

		const frame = evaluateDocumentFrame({document});
		expect(frame.layers.map((layer) => layer.id)).toEqual(['group', 'pixel']);
		const evaluated = frame.layers.find((layer) => layer.id === pixel.id)!;
		expect(evaluated.transform.x).toBe(14);
		expect(evaluated.transform.y).toBe(26);
		expect(evaluated.opacity).toBeCloseTo(0.4);
		expect(buildRenderGraph({document}).nodes.map((node) => node.layer.id)).toEqual(['group', 'pixel']);
	});

	it('uses animation tracks and excludes hidden descendants from render nodes', () => {
		const document = createEmptyDocument({documentId: 'd'});
		document.assets[asset.id] = asset;
		const group = createGroupLayer();
		group.id = 'group';
		const pixel = createPixelLayer(asset.id);
		pixel.id = 'pixel';
		pixel.parentId = group.id;
		pixel.animation = {properties: {x: {baseValue: 0, keyframes: [{frame: 0, value: 0, easing: 'linear'}, {frame: 10, value: 100, easing: 'linear'}]}}};
		document.layers[group.id] = group;
		document.layers[pixel.id] = pixel;
		document.rootLayerIds = [group.id];
		document.animation = {fps: 30, durationInFrames: 20};
		group.visible = false;
		const frame = evaluateDocumentFrame({document, frame: 5});
		expect(frame.layers.find((layer) => layer.id === pixel.id)?.transform.x).toBe(50);
		expect(frame.nodes).toHaveLength(0);
	});

	it('emits adjustment nodes with the layers they affect', () => {
		const document = createEmptyDocument();
		document.assets[asset.id] = asset;
		const pixel = createPixelLayer(asset.id);
		pixel.id = 'pixel';
		const adjustment = {
			...createGroupLayer('Adjustment'),
			id: 'adjustment',
			kind: 'adjustment' as const,
			content: {kind: 'invert' as const},
			order: 1,
		};
		document.layers[pixel.id] = pixel;
		document.layers[adjustment.id] = adjustment;
		document.rootLayerIds = [pixel.id, adjustment.id];
		const adjustmentNode = evaluateDocumentFrame({document}).nodes.find((node) => node.kind === 'adjustment');
		expect(adjustmentNode?.kind).toBe('adjustment');
		expect(adjustmentNode && adjustmentNode.inputNodeIds).toEqual(['pixel']);
	});
});
