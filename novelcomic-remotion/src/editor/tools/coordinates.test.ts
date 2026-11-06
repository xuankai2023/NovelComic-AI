import {describe, expect, it} from 'vitest';
import {documentToLayer, documentToViewport, invertAffine, layerToDocument, layerToAssetPixel, viewportToDocument} from './coordinates';
import {createEmptyDocument, createPixelLayer, createGroupLayer} from '../document/defaults';

describe('tool coordinates', () => {
	it('round trips nested rotated layers', () => {
		const document = createEmptyDocument({width: 100, height: 100});
		const group = createGroupLayer(); group.transform = {...group.transform, originX: 20, originY: 10, rotation: 15};
		const layer = createPixelLayer('asset', 'layer', 20, 10); layer.parentId = group.id; layer.transform = {...layer.transform, originX: 5, originY: 4, rotation: -20, scaleX: -1.5};
		document.layers[group.id] = group; document.layers[layer.id] = layer;
		const point = {x: 3, y: 2}; const world = layerToDocument(point, document, layer.id); expect(world).not.toBeNull();
		expect(documentToLayer(world!, document, layer.id)).toEqual({x: expect.closeTo(point.x), y: expect.closeTo(point.y)});
	});
	it('maps local points into asset pixels', () => {
		const layer = createPixelLayer('a', 'x', 200, 100); const pixel = layerToAssetPixel({x: 100, y: 25}, layer, {id: 'a', kind: 'raster', originalName: 'x', mimeType: 'image/png', width: 400, height: 200, byteSize: 1, objectKey: '', contentHash: ''}); expect(pixel).toEqual({x: 200, y: 50});
	});
	it('rejects singular matrices', () => expect(invertAffine({a: 0, b: 0, c: 0, d: 1, e: 0, f: 0})).toBeNull());
	it('round trips viewport coordinates independently of DPR', () => {
		const snapshot = {
			viewport: {width: 1000, height: 800},
			document: {width: 400, height: 200},
			transform: {zoom: 2, panX: 35, panY: -12, rotation: 0 as const, devicePixelRatio: 3},
			followsFit: false,
			pointsPerPixel: 2,
		};
		const point = {x: 120.5, y: 80.25};
		const viewport = documentToViewport(point, snapshot);
		expect(viewportToDocument(viewport, snapshot).x).toBeCloseTo(point.x);
		expect(viewportToDocument(viewport, snapshot).y).toBeCloseTo(point.y);
	});
});
