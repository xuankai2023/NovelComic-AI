import {describe, expect, it} from 'vitest';
import {createEmptyDocument, createShapeLayer} from './defaults';
import {ellipseSelection, expandSelection, featherSelection, polygonSelection, rectangleSelection, selectionBounds, selectionToMaskRgba, combineSelections, invertSelection} from './selection';
import {getDocumentSnapTargets, snapBounds} from './snap';
import {flipTransform, getTransformBounds, translateTransform} from './transform';
import {DocumentCommandBus} from '../commands/document-command-bus';
import {createDocumentCommand} from '../commands/document-command-types';

describe('stage five transform, snap and selection', () => {
	it('computes rotated bounds and preserves non-destructive transforms', () => {
		const transform = {originX: 10, originY: 20, width: 100, height: 40, rotation: 90, scaleX: 1, scaleY: 1, sampling: 'smooth' as const};
		const bounds = getTransformBounds(transform);
		expect(bounds.width).toBeCloseTo(40);
		expect(bounds.height).toBeCloseTo(100);
		expect(translateTransform(transform, 5, -2).originX).toBe(15);
		expect(flipTransform(transform, 'x').scaleX).toBe(-1);
	});
	it('snaps to canvas center in document coordinates', () => {
		const document = createEmptyDocument({width: 100, height: 100});
		const result = snapBounds({left: 44, top: 10, right: 54, bottom: 20, width: 10, height: 10, centerX: 49, centerY: 15}, getDocumentSnapTargets(document), {zoom: 1, thresholdPx: 3});
		expect(result.dx).toBe(1);
		expect(result.points.some((point) => point.target.kind === 'canvas-center')).toBe(true);
	});
	it('supports geometric selection operations and mask conversion', () => {
		const rectangle = rectangleSelection(8, 8, {x: 2, y: 2, width: 3, height: 3});
		const ellipse = ellipseSelection(8, 8, {x: 0, y: 0, width: 4, height: 4});
		const combined = combineSelections(rectangle, ellipse, 'add');
		expect(selectionBounds(combined)).toEqual({x: 0, y: 0, width: 5, height: 5});
		expect(selectionToMaskRgba(featherSelection(expandSelection(rectangle, 1), 1)).length).toBe(8 * 8 * 4);
		expect(selectionBounds(invertSelection(rectangle))).toEqual({x: 0, y: 0, width: 8, height: 8});
		expect(selectionBounds(polygonSelection(8, 8, [{x: 1, y: 1}, {x: 6, y: 1}, {x: 1, y: 6}]))).toEqual({x: 1, y: 1, width: 4, height: 4});
	});
	it('commits transform and selection through document commands', () => {
		const document = createEmptyDocument({projectId: 'p'});
		const layer = createShapeLayer('rectangle', 'Shape', 10, 10);
		const bus = new DocumentCommandBus();
		const withLayer = bus.execute(document, createDocumentCommand({projectId: 'p', type: 'layer.create', payload: {layer}})).document;
		const transformed = bus.execute(withLayer, createDocumentCommand({projectId: 'p', type: 'layer.transform', payload: {layerId: layer.id, transform: translateTransform(layer.transform, 5, 6)}})).document;
		expect(transformed.layers[layer.id].transform.originX).toBe(5);
		const selected = bus.execute(transformed, createDocumentCommand({projectId: 'p', type: 'selection.commit', payload: {selection: {id: 'active-selection', bounds: {x: 1, y: 2, width: 3, height: 4}, feather: 0}}})).document;
		expect(selected.selections['active-selection']?.bounds.width).toBe(3);
	});
});
