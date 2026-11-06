import {describe, expect, it} from 'vitest';
import {documentCommandBus} from '../commands/document-command-bus';
import {createDocumentCommand} from '../commands/document-command-types';
import {createAdjustmentLayer, createEmptyDocument, createPixelLayer} from '../document';
import {createDefaultCameraRawSettings} from '../document/camera-raw';
import {applyCameraRaw} from '../pixels/camera-raw';
import {applyGradient, cloneStamp, contentAwareFill, createPixelBuffer, eraseBrush, magicWandSelection, paintBrush, removeBackground, selectSubject, smudgePixels, spotHealing} from '../pixels/pixel-tools';

describe('Compositor stage 10 acceptance', () => {
	it('runs the complete pixel-tool set without mutating the input', () => {
		const source = createPixelBuffer(16, 16, [40, 80, 120, 255]);
		const painted = paintBrush(source, [{x: 4, y: 4}], {size: 8, hardness: .5, color: [255, 0, 0, 255]});
		const erased = eraseBrush(painted, [{x: 4, y: 4}], {size: 2});
		const smudged = smudgePixels(erased, [{x: 3, y: 3}, {x: 5, y: 5}], {size: 5, strength: .5});
		const cloned = cloneStamp(smudged, {x: 1, y: 1}, [{x: 8, y: 8}], {size: 5});
		const healed = spotHealing(cloned, [{x: 8, y: 8}], {size: 5});
		const gradient = applyGradient(healed, {start: [0, 0, 0, 255], end: [255, 255, 255, 255]});
		const subject = selectSubject(gradient);
		const wand = magicWandSelection(gradient, {x: 2, y: 2});
		const filled = contentAwareFill(gradient, wand);
		const removed = removeBackground(filled, subject);
		expect(removed.data).not.toBe(source.data);
		expect(source.data.every((value) => value === 40 || value === 80 || value === 120 || value === 255)).toBe(true);
	});
	it('stores Camera Raw settings through the document command history', () => {
		const document = createEmptyDocument({documentId: 'stage10', projectId: 'stage10-project'});
		const layer = createAdjustmentLayer({kind: 'camera-raw', settings: createDefaultCameraRawSettings()}); layer.id = 'raw'; layer.order = 0;
		document.layers[layer.id] = layer; document.rootLayerIds = [layer.id];
		const settings = {...createDefaultCameraRawSettings(), exposure: 1, dither: {...createDefaultCameraRawSettings().dither, enabled: true, levels: 2}};
		const command = createDocumentCommand({projectId: document.projectId, type: 'camera-raw.update', payload: {layerId: layer.id, settings}});
		const applied = documentCommandBus.execute(document, command).document;
		expect(applied.layers.raw?.content).toEqual({kind: 'camera-raw', settings});
		const rendered = applyCameraRaw(createPixelBuffer(2, 2, [80, 80, 80, 255]), settings);
		expect(rendered.data.length).toBe(16);
	});
	it('replaces raster pixels with an undoable document command', () => {
		const document = createEmptyDocument({documentId: 'stage10-pixel', projectId: 'stage10-pixel-project'});
		const oldAsset = {id: 'old', kind: 'raster' as const, originalName: 'old.png', mimeType: 'image/png', byteSize: 4, objectKey: 'old', contentHash: 'old'};
		const layer = createPixelLayer(oldAsset.id, 'Pixel', 1, 1); layer.id = 'pixel'; document.assets[oldAsset.id] = oldAsset; document.layers[layer.id] = layer; document.rootLayerIds = [layer.id];
		const nextAsset = {...oldAsset, id: 'new', objectKey: 'new', contentHash: 'new'};
		const result = documentCommandBus.execute(document, createDocumentCommand({projectId: document.projectId, type: 'pixel.replace', payload: {layerId: layer.id, asset: nextAsset}})).document;
		expect(result.layers.pixel?.content).toEqual({kind: 'pixel', assetId: 'new'});
	});
});
