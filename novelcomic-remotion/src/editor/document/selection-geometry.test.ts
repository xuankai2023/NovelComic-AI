import {describe, expect, it} from 'vitest';
import {createEmptyDocument} from './defaults';
import {
	applyLasso,
	applyMarquee,
	contractShape,
	dragBox,
	expandShape,
	marqueeAutoscrollDelta,
	rectOutlineLoops,
	selectionCoverage,
	shapeBounds,
	snapMarqueePoint,
	marqueeSnapTargets,
} from './selection-geometry';

describe('marquee geometry', () => {
	it('rounds a drag to whole pixels in any direction and can grow from the center', () => {
		expect(dragBox({x: 60, y: 71}, {x: 20.2, y: 30.3}, false, false)).toEqual({x: 20, y: 30, width: 40, height: 41});
		expect(dragBox({x: 10, y: 10}, {x: 40, y: 20}, true, false)).toEqual({x: 10, y: 10, width: 30, height: 30});
		expect(dragBox({x: 50, y: 50}, {x: 60, y: 55}, false, true)).toEqual({x: 40, y: 45, width: 20, height: 10});
		expect(dragBox({x: 50, y: 50}, {x: 45, y: 58}, true, true)).toEqual({x: 42, y: 42, width: 16, height: 16});
	});

	it('combines rectangles and clips them to the canvas', () => {
		const canvas = {width: 100, height: 100};
		const first = applyMarquee(null, {x: 20, y: 30, width: 40, height: 41}, 'rectangle', 'replace', canvas);
		expect(first).toEqual({kind: 'rect', bounds: {x: 20, y: 30, width: 40, height: 41}});
		expect(selectionCoverage(first === 'deselect' || first === 'unchanged' ? null : first, 20, 30)).toBe(255);
		expect(selectionCoverage(first === 'deselect' || first === 'unchanged' ? null : first, 19, 30)).toBe(0);
		const added = applyMarquee(first === 'deselect' || first === 'unchanged' ? null : first, {x: 80, y: 80, width: 10, height: 10}, 'rectangle', 'add', canvas);
		expect(selectionCoverage(added === 'deselect' || added === 'unchanged' ? null : added, 85, 85)).toBe(255);
		expect(selectionCoverage(added === 'deselect' || added === 'unchanged' ? null : added, 40, 50)).toBe(255);
		const cut = applyMarquee(added === 'deselect' || added === 'unchanged' ? null : added, {x: 30, y: 40, width: 20, height: 20}, 'rectangle', 'subtract', canvas);
		expect(selectionCoverage(cut === 'deselect' || cut === 'unchanged' ? null : cut, 40, 50)).toBe(0);
		expect(selectionCoverage(cut === 'deselect' || cut === 'unchanged' ? null : cut, 25, 35)).toBe(255);
		expect(applyMarquee(null, {x: -20, y: -20, width: 10, height: 10}, 'rectangle', 'replace', canvas)).toEqual({kind: 'empty'});
		expect(applyMarquee(null, {x: 5, y: 5, width: 0, height: 0}, 'rectangle', 'replace', canvas)).toBe('deselect');
		expect(applyMarquee(null, {x: 5, y: 5, width: 4, height: 4}, 'rectangle', 'subtract', canvas)).toBe('unchanged');
	});

	it('keeps an ellipse off the corners of its box and squares it into a circle', () => {
		const canvas = {width: 100, height: 100};
		const oval = applyMarquee(null, {x: 10, y: 20, width: 60, height: 40}, 'ellipse', 'replace', canvas);
		expect(selectionCoverage(oval === 'deselect' || oval === 'unchanged' ? null : oval, 40, 40)).toBe(255);
		expect(selectionCoverage(oval === 'deselect' || oval === 'unchanged' ? null : oval, 11, 21)).toBe(0);
		const circle = dragBox({x: 5, y: 5}, {x: 45, y: 25}, true, false);
		expect(circle.width).toBe(circle.height);
	});

	it('draws one outline for a rectangle and two for a hole', () => {
		expect(rectOutlineLoops([{x: 10, y: 10, width: 20, height: 20}])).toHaveLength(1);
		const frame = [
			{x: 0, y: 0, width: 30, height: 10},
			{x: 0, y: 20, width: 30, height: 10},
			{x: 0, y: 10, width: 10, height: 10},
			{x: 20, y: 10, width: 10, height: 10},
		];
		expect(rectOutlineLoops(frame)).toHaveLength(2);
		expect(rectOutlineLoops([{x: 0, y: 0, width: 10, height: 10}, {x: 10, y: 0, width: 10, height: 10}])).toHaveLength(1);
	});

	it('expands inside the canvas and can contract to empty', () => {
		const canvas = {width: 100, height: 100};
		const grown = expandShape({kind: 'rect', bounds: {x: 40, y: 40, width: 20, height: 20}}, 5, canvas);
		expect(grown).toEqual({kind: 'rect', bounds: {x: 35, y: 35, width: 30, height: 30}});
		expect(contractShape(grown, 8)).toEqual({kind: 'rect', bounds: {x: 43, y: 43, width: 14, height: 14}});
		const full = contractShape({kind: 'rect', bounds: {x: 0, y: 0, width: 100, height: 100}}, 10);
		expect(selectionCoverage(full, 5, 50)).toBe(0);
		expect(selectionCoverage(full, 50, 50)).toBe(255);
		expect(contractShape(full, 45)).toEqual({kind: 'empty'});
		expect(expandShape({kind: 'rect', bounds: {x: 0, y: 0, width: 100, height: 100}}, 10, canvas)).toEqual({
			kind: 'rect',
			bounds: {x: 0, y: 0, width: 100, height: 100},
		});
	});

	it('snaps a corner to the canvas edge unless snapping is disabled', () => {
		const document = createEmptyDocument({width: 100, height: 100});
		const targets = marqueeSnapTargets(document);
		expect(snapMarqueePoint({x: 8, y: 20}, targets, 10, true).point).toEqual({x: 0, y: 20});
		expect(snapMarqueePoint({x: 8, y: 20}, targets, 10, false).point).toEqual({x: 8, y: 20});
	});

	it('combines lasso polygons, clips them, and can leave an explicit empty selection', () => {
		const canvas = {width: 100, height: 100};
		const square = (x: number, y: number, size: number) => [
			{x, y},
			{x: x + size, y},
			{x: x + size, y: y + size},
			{x, y: y + size},
		];
		const shape = (value: ReturnType<typeof applyLasso>) => (value === 'deselect' || value === 'unchanged' ? null : value);
		const first = applyLasso(null, square(10, 10, 40), 'replace', canvas);
		expect(selectionCoverage(shape(first), 30, 30)).toBe(255);
		expect(selectionCoverage(shape(first), 70, 70)).toBe(0);
		const added = applyLasso(shape(first), square(50, 50, 40), 'add', canvas);
		expect(selectionCoverage(shape(added), 30, 30)).toBe(255);
		expect(selectionCoverage(shape(added), 70, 70)).toBe(255);
		const cut = applyLasso(shape(added), square(20, 20, 20), 'subtract', canvas);
		expect(selectionCoverage(shape(cut), 30, 30)).toBe(0);
		expect(selectionCoverage(shape(cut), 15, 15)).toBe(255);
		expect(applyLasso(null, [{x: 5, y: 5}], 'replace', canvas)).toBe('deselect');
		expect(applyLasso(null, square(10, 10, 20), 'subtract', canvas)).toBe('unchanged');
		const covered = applyLasso(shape(applyLasso(null, square(10, 10, 20), 'replace', canvas)), square(0, 0, 60), 'subtract', canvas);
		expect(covered).toEqual({kind: 'empty'});
		const clipped = applyLasso(null, square(-50, -50, 100), 'replace', canvas);
		expect(shapeBounds(shape(clipped))).toEqual({x: 0, y: 0, width: 50, height: 50});
	});

	it('antialiases a diagonal lasso edge and can keep that edge hard', () => {
		const canvas = {width: 100, height: 100};
		const triangle = applyLasso(null, [{x: 0, y: 0}, {x: 100, y: 0}, {x: 0, y: 100}], 'replace', canvas);
		const outline = triangle === 'deselect' || triangle === 'unchanged' ? null : triangle;
		const edge = (antialiased: boolean) =>
			Array.from({length: 100}, (_, index) => selectionCoverage(outline, index, 99 - index, {antialiased}));
		expect(edge(true).some((value) => value > 0 && value < 255)).toBe(true);
		expect(edge(false).every((value) => value === 0 || value === 255)).toBe(true);
	});

	it('grows and shrinks a lasso polygon the way Expand and Contract do', () => {
		const canvas = {width: 100, height: 100};
		const square = {kind: 'polygon' as const, points: [{x: 40, y: 40}, {x: 60, y: 40}, {x: 60, y: 60}, {x: 40, y: 60}]};
		const grown = expandShape(square, 5, canvas);
		expect(shapeBounds(grown)).toEqual({x: 35, y: 35, width: 30, height: 30});
		expect(selectionCoverage(grown, 37, 50)).toBe(255);
		expect(selectionCoverage(grown, 33, 50)).toBe(0);
		const shrunk = contractShape(grown, 8);
		expect(shapeBounds(shrunk)).toEqual({x: 43, y: 43, width: 14, height: 14});
		expect(contractShape({kind: 'polygon', points: [{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}, {x: 0, y: 10}]}, 6)).toEqual({kind: 'empty'});
		expect(shapeBounds(expandShape({kind: 'polygon', points: [{x: 0, y: 0}, {x: 20, y: 0}, {x: 20, y: 20}, {x: 0, y: 20}]}, 5, canvas))).toEqual({
			x: 0,
			y: 0,
			width: 25,
			height: 25,
		});
	});

	it('pans faster as the pointer passes the viewport edge', () => {
		expect(marqueeAutoscrollDelta({x: 100, y: 100}, {width: 200, height: 200})).toEqual({x: 0, y: 0});
		const delta = marqueeAutoscrollDelta({x: 200, y: 100}, {width: 200, height: 200});
		expect(delta.x).toBeLessThan(0);
		expect(delta.y).toBe(0);
	});
});
