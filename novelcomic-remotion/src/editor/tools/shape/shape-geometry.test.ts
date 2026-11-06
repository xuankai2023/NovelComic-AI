import {describe, expect, it} from 'vitest';
import {createEmptyDocument, createShapeLayer} from '../../document/defaults';
import {beginShapeDraft, commitShapeBounds, dragShapeDraft, nextShapeName, shapeInsertionOrder, shapeParentId} from './shape-geometry';
import {SHAPE_KIND_NAMES} from './shape-settings';

describe('shape geometry', () => {
	it('squares a rectangle and grows an ellipse from the center', () => {
		const box = beginShapeDraft({x: 10.4, y: 10.2}, 'rectangle', 8);
		expect(box).toMatchObject({anchor: {x: 10, y: 10}, cornerRadius: 8});
		const squared = dragShapeDraft(box!, {x: 40, y: 20}, true, false);
		expect(squared.rect).toEqual({x: 10, y: 10, width: 30, height: 30});
		const ellipse = beginShapeDraft({x: 50, y: 40}, 'ellipse', 500)!;
		expect(ellipse.cornerRadius).toBe(0);
		const circle = dragShapeDraft(ellipse, {x: 60, y: 45}, true, true);
		expect(circle.rect).toEqual({x: 40, y: 30, width: 20, height: 20});
	});

	it('snaps a line to 45 degrees and pads the stroke', () => {
		const draft = dragShapeDraft(beginShapeDraft({x: 0, y: 0}, 'line', 0)!, {x: 10, y: 9}, true, false);
		expect(draft.end!.x).toBeCloseTo(draft.end!.y);
		const flat = dragShapeDraft(beginShapeDraft({x: 10, y: 20}, 'line', 0)!, {x: 40, y: 20}, false, false);
		const bounds = commitShapeBounds(flat, 4);
		expect(bounds).toMatchObject({
			status: 'ok',
			rect: {x: 8, y: 18, width: 34, height: 4},
			start: {x: 2 / 34, y: 0.5},
			end: {x: 32 / 34, y: 0.5},
		});
		const click = commitShapeBounds(beginShapeDraft({x: 20, y: 20}, 'line', 0)!, 4);
		expect(click).toMatchObject({status: 'ok', rect: {x: 18, y: 18, width: 4, height: 4}, start: {x: 0.5, y: 0.5}, end: {x: 0.5, y: 0.5}});
	});

	it('drops a click on a rectangle and rejects an oversized box', () => {
		const click = beginShapeDraft({x: 20, y: 20}, 'rectangle', 0)!;
		expect(commitShapeBounds(click, 4)).toBe('empty');
		const huge = dragShapeDraft(click, {x: 20_020, y: 20_020}, false, false);
		expect(commitShapeBounds(huge, 4)).toMatchObject({status: 'too-large'});
	});

	it('names shapes and stacks a new one above the active layer', () => {
		expect(nextShapeName('rectangle', ['Rectangle 1', 'Layer 1'])).toBe('Rectangle 2');
		expect(SHAPE_KIND_NAMES.ellipse).toBe('Ellipse');
		const document = createEmptyDocument({width: 100, height: 80});
		const below = createShapeLayer('rectangle', 'Below', 10, 10);
		below.id = 'below';
		below.order = 0;
		const above = createShapeLayer('rectangle', 'Above', 10, 10);
		above.id = 'above';
		above.order = 1;
		document.layers = {below, above};
		document.rootLayerIds = ['below', 'above'];
		expect(shapeParentId(document, 'below')).toBeNull();
		expect(shapeInsertionOrder(document, 'below', null)).toBe(0.5);
		const folder = createShapeLayer('rectangle', 'Folder', 10, 10);
		folder.id = 'folder';
		folder.kind = 'group';
		folder.content = {kind: 'group', group: true};
		const child = createShapeLayer('rectangle', 'Child', 10, 10);
		child.id = 'child';
		child.parentId = 'folder';
		child.order = 0;
		const grouped = createEmptyDocument({width: 20, height: 20});
		grouped.layers = {folder, child};
		grouped.rootLayerIds = ['folder'];
		expect(shapeParentId(grouped, 'folder')).toBe('folder');
		expect(shapeInsertionOrder(grouped, 'folder', 'folder')).toBe(-1);
	});
});
