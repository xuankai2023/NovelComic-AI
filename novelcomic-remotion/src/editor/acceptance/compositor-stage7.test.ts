import {describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../commands/document-command-history';
import {createDocumentCommand} from '../commands/document-command-types';
import {
	createAdjustmentLayer,
	createEmptyDocument,
	createShapeLayer,
	createTextLayer,
} from '../document';
import type {AdjustmentContent, LayerEffect, LayerEffectKind} from '../document';
import {canonicalDocumentJson} from '../document/normalize';
import {buildRenderGraph} from '../render-graph/build-render-graph';
import {adjustmentFilter} from '../render-graph/render-adjustment';
import {effectsStyle} from '../render-graph/render-effects';

const effectValue = (kind: LayerEffectKind): LayerEffect => {
	const color = {r: 20, g: 40, b: 80, a: 1};
	if (kind === 'stroke') return {enabled: true, color, size: 4, position: 'outside', opacity: 1};
	if (kind === 'colorOverlay') return {enabled: true, color, opacity: 0.5, blendMode: 'normal'};
	if (kind === 'outerGlow' || kind === 'innerGlow') return {enabled: true, color, opacity: 0.75, size: 12, spread: 2};
	return {enabled: true, color, opacity: 0.75, angle: 45, distance: 8, size: 12, spread: 2};
};

describe('Compositor stage 7: adjustments, effects, text and shapes', () => {
	it('creates, edits, toggles, deletes and undoes every layer effect', () => {
		let document = createEmptyDocument({projectId: 'stage7'});
		const layer = createShapeLayer('rectangle', 'Shape', 160, 100);
		layer.id = 'shape';
		document.layers[layer.id] = layer;
		document.rootLayerIds = [layer.id];
		const history = new DocumentCommandHistory();
		for (const effect of ['stroke', 'dropShadow', 'colorOverlay', 'innerShadow', 'outerGlow', 'innerGlow'] as const) {
			document = history.execute(document, createDocumentCommand({type: 'effect.set', projectId: document.projectId, payload: {layerId: layer.id, effect, value: effectValue(effect)}}));
			const reloaded = JSON.parse(canonicalDocumentJson(document));
			expect(reloaded.layers[layer.id].effects[effect]).toEqual(effectValue(effect));
			document = history.execute(document, createDocumentCommand({type: 'effect.update', projectId: document.projectId, payload: {layerId: layer.id, effect, changes: {enabled: false}}}));
			expect(document.layers[layer.id].effects?.[effect]?.enabled).toBe(false);
			document = history.execute(document, createDocumentCommand({type: 'effect.update', projectId: document.projectId, payload: {layerId: layer.id, effect, changes: {enabled: true}}}));
			document = history.execute(document, createDocumentCommand({type: 'effect.remove', projectId: document.projectId, payload: {layerId: layer.id, effect}}));
			expect(document.layers[layer.id].effects?.[effect]).toBeUndefined();
			document = history.undo(document);
			expect(document.layers[layer.id].effects?.[effect]?.enabled).toBe(true);
		}
		expect(effectsStyle(document.layers[layer.id].effects).boxShadow).toContain('rgba');
	});

	it('keeps adjustment, text and shape edits typed and undoable', () => {
		let document = createEmptyDocument({projectId: 'stage7'});
		const adjustment = createAdjustmentLayer({kind: 'invert'}, 'Adjustment');
		adjustment.id = 'adjustment';
		const text = createTextLayer('Hello', 'Text', 300, 80);
		text.id = 'text';
		const shape = createShapeLayer('rectangle', 'Shape', 300, 80);
		shape.id = 'shape';
		text.order = 1;
		shape.order = 2;
		document.layers = {[adjustment.id]: adjustment, [text.id]: text, [shape.id]: shape};
		document.rootLayerIds = [adjustment.id, text.id, shape.id];
		const history = new DocumentCommandHistory();
		document = history.execute(document, createDocumentCommand({type: 'adjustment.update', projectId: document.projectId, payload: {layerId: adjustment.id, content: {kind: 'gaussian-blur', radius: 12}}}));
		document = history.execute(document, createDocumentCommand({type: 'text.update', projectId: document.projectId, payload: {layerId: text.id, changes: {text: 'Edited', fontSize: 72}}}));
		document = history.execute(document, createDocumentCommand({type: 'shape.update', projectId: document.projectId, payload: {layerId: shape.id, changes: {shape: 'rounded-rectangle', cornerRadius: 18}}}));
		expect(document.layers[adjustment.id].content).toEqual({kind: 'gaussian-blur', radius: 12});
		const textContent = document.layers[text.id].content;
		const shapeContent = document.layers[shape.id].content;
		expect(textContent.kind === 'text' ? textContent.text : undefined).toBe('Edited');
		expect(shapeContent.kind === 'shape' ? shapeContent.cornerRadius : undefined).toBe(18);
		document = history.undo(document);
		const undoneShape = document.layers[shape.id].content;
		expect(undoneShape.kind === 'shape' ? undoneShape.shape : undefined).toBe('rectangle');
	});

	it('round-trips compositor content through canonical save/reload and render graph', () => {
		const document = createEmptyDocument({projectId: 'stage7'});
		const adjustment = createAdjustmentLayer({kind: 'hue-saturation', hue: 10, saturation: 20, lightness: 0, colorize: false});
		adjustment.id = 'adjustment';
		document.layers[adjustment.id] = adjustment;
		document.rootLayerIds = [adjustment.id];
		const reloaded = JSON.parse(canonicalDocumentJson(document));
		expect(canonicalDocumentJson(reloaded)).toBe(canonicalDocumentJson(document));
		expect(adjustmentFilter(adjustment.content.kind === 'hue-saturation' ? adjustment.content : {kind: 'invert'})).toContain('hue-rotate');
		const graph = buildRenderGraph({document, quality: 'final'});
		expect(graph.nodes[0]?.kind).toBe('adjustment');
		expect(graph.frame.quality).toBe('final');
	});

	it('maps every adjustment kind into both preview and final render graphs', () => {
		const adjustments: AdjustmentContent[] = [
			{kind: 'hue-saturation', hue: 10, saturation: 20, lightness: -5, colorize: false},
			{kind: 'levels', channels: [{inputBlack: 4, inputWhite: 240, gamma: 1.1, outputBlack: 0, outputWhite: 255}]},
			{kind: 'curves', channels: [{channel: 'rgb', points: [{x: 0, y: 0.05}, {x: 1, y: 0.95}]}]},
			{kind: 'exposure', exposure: 0.5, offset: 0.02, gamma: 1},
			{kind: 'gradient-map', shadows: {r: 0, g: 0, b: 20, a: 1}, highlights: {r: 255, g: 230, b: 180, a: 1}, reversed: false},
			{kind: 'grain', amount: 0.25, monochromatic: true, seed: 7},
			{kind: 'invert'},
			{kind: 'black-white', settings: {reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80}},
			{kind: 'color-balance', settings: {shadows: [0, 0, 0], midtones: [10, -5, 8], highlights: [0, 0, 0], preserveLuminosity: true}},
			{kind: 'gaussian-blur', radius: 8},
			{kind: 'motion-blur', angle: 30, distance: 12},
			{kind: 'add-noise', amount: 0.2, gaussian: true, monochromatic: false, seed: 9},
		];
		for (const content of adjustments) {
			const document = createEmptyDocument({projectId: `stage7-${content.kind}`});
			const adjustment = createAdjustmentLayer(structuredClone(content));
			adjustment.id = 'adjustment';
			document.layers[adjustment.id] = adjustment;
			document.rootLayerIds = [adjustment.id];
			expect(adjustmentFilter(adjustment.content as AdjustmentContent)).toBeTruthy();
			const preview = buildRenderGraph({document, quality: 'preview'});
			const final = buildRenderGraph({document, quality: 'final'});
			expect(preview.nodes).toEqual(final.nodes);
			expect(preview.frame.quality).toBe('preview');
			expect(final.frame.quality).toBe('final');
		}
	});
});
