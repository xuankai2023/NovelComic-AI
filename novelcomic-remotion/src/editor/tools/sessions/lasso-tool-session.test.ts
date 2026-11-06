import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand} from '../../commands/document-command-types';
import {createEmptyDocument} from '../../document/defaults';
import {ACTIVE_SELECTION_ID, selectionCoverage, shapeBounds, shapeFromRecord} from '../../document/selection-geometry';
import type {DocumentState} from '../../document/types';
import {documentToViewport} from '../coordinates';
import {lassoDrawCursor, lassoMoveCursor} from '../lasso/lasso-cursors';
import {getLassoToolSettings, resetLassoToolSettings, updateLassoToolSettings} from '../lasso/lasso-settings';
import {ToolController} from '../tool-controller';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {LassoToolSession} from './lasso-tool-session';

const modifiers = (patch: Partial<ToolModifiers> = {}): ToolModifiers => ({
	shift: false,
	alt: false,
	meta: false,
	control: false,
	space: false,
	...patch,
});

const viewport = {
	viewport: {width: 800, height: 600},
	document: {width: 100, height: 100},
	transform: {zoom: 1, panX: 0, panY: 0, rotation: 0, devicePixelRatio: 1},
	followsFit: false,
	pointsPerPixel: 1,
};

const harness = () => {
	const history = new DocumentCommandHistory();
	const context = {
		document: createEmptyDocument({width: 100, height: 100, projectId: 'p'}),
		selectedLayerIds: [],
		activeLayerId: null,
		viewport: structuredClone(viewport),
		setSelection: () => undefined,
		clearSelection: () => undefined,
		commitSelection: (selection: DocumentState['selections'][string] | null) => {
			context.document = history.execute(
				context.document,
				createDocumentCommand({
					type: 'selection.commit',
					payload: {selection},
					projectId: context.document.projectId,
				}),
			);
		},
		dispatch: () => undefined,
		dispatchCommands: () => undefined,
		setViewportPan: () => undefined,
		setViewportZoom: () => undefined,
	} as ToolSessionContext;
	const session = new LassoToolSession(context);
	const pointer = (x: number, y: number, keys: Partial<ToolModifiers> = {}, clickCount = 1): ToolPointerEvent => {
		const documentPoint = {x, y};
		return {
			pointerId: 1,
			pointerType: 'mouse',
			buttons: 1,
			pressure: 1,
			clickCount,
			clientPoint: documentPoint,
			viewportPoint: documentToViewport(documentPoint, context.viewport),
			documentPoint,
			modifiers: modifiers(keys),
		};
	};
	return {
		history,
		context,
		session,
		pointer,
		get document() {
			return context.document;
		},
		shape() {
			return shapeFromRecord(context.document.selections[ACTIVE_SELECTION_ID]);
		},
		coverage(x: number, y: number) {
			return selectionCoverage(this.shape(), x, y);
		},
	};
};

const square = (x: number, y: number, size: number) => [
	{x, y},
	{x: x + size, y},
	{x: x + size, y: y + size},
	{x, y: y + size},
];

const trace = (tool: ReturnType<typeof harness>, points: Array<{x: number; y: number}>, keys: Partial<ToolModifiers> = {}) => {
	const [first, ...rest] = points;
	tool.session.pointerDown(tool.pointer(first!.x, first!.y, keys));
	for (const point of rest) tool.session.pointerMove(tool.pointer(point.x, point.y, keys));
	const last = points.at(-1)!;
	tool.session.pointerUp(tool.pointer(last.x, last.y, keys));
};

describe('lasso tool session', () => {
	beforeEach(() => resetLassoToolSettings());

	it('badges the crosshair for the outline mode and switches to the move cursor inside a selection', () => {
		const tool = harness();
		expect(tool.session.getOverlayState()?.canvasCursor).toBe(lassoDrawCursor('freehand', 'replace'));
		tool.session.pointerMove(tool.pointer(4, 4, {shift: true}));
		expect(tool.session.getOverlayState()?.canvasCursor).toBe(lassoDrawCursor('freehand', 'add'));
		tool.session.pointerMove(tool.pointer(4, 4, {alt: true}));
		expect(tool.session.getOverlayState()?.canvasCursor).toBe(lassoDrawCursor('freehand', 'subtract'));
		trace(tool, square(10, 10, 40));
		tool.session.pointerMove(tool.pointer(20, 20));
		expect(tool.session.getOverlayState()?.canvasCursor).toBe(lassoMoveCursor);
		tool.session.pointerDown(tool.pointer(4, 4, {shift: true}));
		tool.session.pointerMove(tool.pointer(30, 30));
		expect(tool.session.getOverlayState()?.canvasCursor).toBe(lassoDrawCursor('freehand', 'add'));
		updateLassoToolSettings({kind: 'polygonal'});
		tool.session.pointerCancel('escape');
		tool.session.pointerMove(tool.pointer(2, 2));
		expect(tool.session.getOverlayState()?.canvasCursor).toBe(lassoDrawCursor('polygonal', 'replace'));
	});

	it('draws a freehand outline, adds, subtracts, and deselects a click', () => {
		const tool = harness();
		trace(tool, square(10, 10, 40));
		expect(tool.coverage(30, 30)).toBe(255);
		expect(tool.coverage(70, 70)).toBe(0);
		expect(tool.document.selections[ACTIVE_SELECTION_ID]?.geometry?.antialiased).toBe(true);
		trace(tool, square(50, 50, 40), {shift: true});
		expect(tool.coverage(30, 30)).toBe(255);
		expect(tool.coverage(70, 70)).toBe(255);
		trace(tool, square(20, 20, 20), {alt: true});
		expect(tool.coverage(30, 30)).toBe(0);
		expect(tool.coverage(15, 15)).toBe(255);
		trace(tool, [{x: 5, y: 5}]);
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toBeUndefined();
		const restored = tool.history.undo(tool.document);
		expect(selectionCoverage(shapeFromRecord(restored.selections[ACTIVE_SELECTION_ID]), 15, 15)).toBe(255);
	});

	it('skips points closer than a quarter pixel and clips to the canvas', () => {
		const tool = harness();
		tool.session.pointerDown(tool.pointer(10, 10));
		tool.session.pointerMove(tool.pointer(10.1, 10.1));
		expect(tool.session.getOverlayState()?.selectionDraft?.points).toEqual([{x: 10, y: 10}]);
		tool.session.pointerMove(tool.pointer(80, 10));
		tool.session.pointerMove(tool.pointer(80, 80));
		tool.session.pointerUp(tool.pointer(80, 80));
		expect(tool.coverage(40, 20)).toBe(255);
		trace(tool, square(-50, -50, 100));
		expect(shapeBounds(tool.shape())).toEqual({x: 0, y: 0, width: 50, height: 50});
	});

	it('subtracts to an explicit empty selection and refuses to move it', () => {
		const tool = harness();
		trace(tool, square(10, 10, 20));
		trace(tool, square(0, 0, 60), {alt: true});
		expect(tool.shape()).toEqual({kind: 'empty'});
		trace(tool, square(70, 70, 20));
		expect(tool.coverage(75, 75)).toBe(255);
		expect(tool.coverage(20, 20)).toBe(0);
	});

	it('moves the outline in whole pixels as one undo and nudges with the arrows', () => {
		const tool = harness();
		trace(tool, square(10, 10, 20));
		tool.session.pointerDown(tool.pointer(20, 20, {control: true}));
		tool.session.pointerMove(tool.pointer(45.4, 30.6, {control: true}));
		tool.session.pointerUp(tool.pointer(45.4, 30.6, {control: true}));
		expect(shapeBounds(tool.shape())).toEqual({x: 35, y: 21, width: 20, height: 20});
		const restored = tool.history.undo(tool.document);
		expect(shapeBounds(shapeFromRecord(restored.selections[ACTIVE_SELECTION_ID]))).toEqual({x: 10, y: 10, width: 20, height: 20});
		tool.session.keyDown({key: 'ArrowRight', modifiers: modifiers()});
		tool.session.keyDown({key: 'ArrowUp', modifiers: modifiers({shift: true})});
		expect(shapeBounds(tool.shape())).toEqual({x: 36, y: 11, width: 20, height: 20});
		tool.session.pointerDown(tool.pointer(40, 20));
		tool.session.pointerUp(tool.pointer(40, 20));
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toBeUndefined();
	});

	it('keeps an outline off the canvas and brings the same shape back', () => {
		const tool = harness();
		trace(tool, square(10, 10, 20));
		tool.session.pointerDown(tool.pointer(20, 20, {control: true}));
		tool.session.pointerMove(tool.pointer(-5, 20, {control: true}));
		tool.session.pointerUp(tool.pointer(-5, 20, {control: true}));
		expect(tool.coverage(0, 20)).toBe(255);
		tool.session.pointerDown(tool.pointer(0, 20, {control: true}));
		tool.session.pointerMove(tool.pointer(25, 20, {control: true}));
		tool.session.pointerUp(tool.pointer(25, 20, {control: true}));
		expect(shapeBounds(tool.shape())).toEqual({x: 10, y: 10, width: 20, height: 20});
	});

	it('cancels a freehand drag with Escape and stores the antialias choice', () => {
		const tool = harness();
		trace(tool, square(10, 10, 20));
		const before = tool.document.selections[ACTIVE_SELECTION_ID];
		tool.session.pointerDown(tool.pointer(40, 40));
		tool.session.pointerMove(tool.pointer(70, 40));
		tool.session.pointerMove(tool.pointer(70, 70));
		tool.session.keyDown({key: 'Escape', modifiers: modifiers()});
		expect(tool.session.getOverlayState()?.selectionDraft).toBeUndefined();
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toEqual(before);
		updateLassoToolSettings({antialiased: false});
		trace(tool, square(40, 40, 20));
		expect(tool.document.selections[ACTIVE_SELECTION_ID]?.geometry?.antialiased).toBe(false);
	});

	it('places polygonal corners, removes the last one, and closes on Enter', () => {
		const tool = harness();
		updateLassoToolSettings({kind: 'polygonal'});
		const click = (x: number, y: number) => {
			tool.session.pointerDown(tool.pointer(x, y));
			tool.session.pointerUp(tool.pointer(x, y));
		};
		click(10, 10);
		click(90, 10);
		click(50, 50);
		tool.session.keyDown({key: 'Backspace', modifiers: modifiers()});
		expect(tool.session.getOverlayState()?.selectionDraft?.points).toEqual([
			{x: 10, y: 10},
			{x: 90, y: 10},
		]);
		click(90, 90);
		click(10, 90);
		expect(tool.session.getOverlayState()?.selectionDraft?.polygonal).toBe(true);
		tool.session.pointerMove(tool.pointer(40, 40));
		expect(tool.session.getOverlayState()?.selectionDraft?.cursor).toEqual({x: 40, y: 40});
		tool.session.keyDown({key: 'Enter', modifiers: modifiers()});
		expect(tool.session.getOverlayState()?.selectionDraft).toBeUndefined();
		expect(tool.coverage(80, 80)).toBe(255);
		expect(tool.coverage(5, 50)).toBe(0);
		click(1, 1);
		tool.session.keyDown({key: 'Escape', modifiers: modifiers()});
		expect(tool.shape()?.kind).toBe('polygon');
	});

	it('closes a polygon on a click near the first corner, measured in view pixels', () => {
		const tool = harness();
		updateLassoToolSettings({kind: 'polygonal'});
		const click = (x: number, y: number, clickCount = 1) => {
			tool.session.pointerDown(tool.pointer(x, y, {}, clickCount));
			tool.session.pointerUp(tool.pointer(x, y, {}, clickCount));
		};
		click(10, 10);
		click(80, 10);
		click(80, 80);
		contextZoom(tool, 4);
		click(13, 10);
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toBeUndefined();
		expect(tool.session.getOverlayState()?.selectionDraft?.points).toHaveLength(4);
		click(11, 10);
		expect(tool.coverage(70, 20)).toBe(255);
		expect(tool.session.getOverlayState()?.selectionDraft).toBeUndefined();
	});

	it('closes a polygon on double-click and Tab switches the mode without changing the tool', () => {
		const tool = harness();
		updateLassoToolSettings({kind: 'polygonal'});
		tool.session.pointerDown(tool.pointer(10, 10));
		tool.session.pointerUp(tool.pointer(10, 10));
		tool.session.pointerDown(tool.pointer(60, 10));
		tool.session.pointerUp(tool.pointer(60, 10));
		tool.session.pointerDown(tool.pointer(60, 50));
		tool.session.pointerUp(tool.pointer(60, 50));
		tool.session.pointerDown(tool.pointer(60, 50, {}, 2));
		expect(tool.coverage(40, 20)).toBe(255);
		tool.session.pointerDown(tool.pointer(4, 4));
		tool.session.keyDown({key: 'Tab', modifiers: modifiers()});
		expect(tool.session.toolId).toBe('lasso');
		expect(getLassoToolSettings().kind).toBe('freehand');
		expect(tool.session.getOverlayState()?.selectionDraft).toBeUndefined();
		expect(tool.coverage(40, 20)).toBe(255);
	});

	it('keeps a polygonal draft when pointer capture ends and drops it on Escape', () => {
		const tool = harness();
		updateLassoToolSettings({kind: 'polygonal'});
		const controller = new ToolController(tool.context);
		controller.activate('lasso');
		const down = tool.pointer(10, 10);
		expect(controller.pointerDown(down)).toBe(true);
		controller.pointerUp(tool.pointer(10, 10));
		controller.pointerCancel('lostpointercapture');
		expect(controller.getOverlayState()?.selectionDraft?.points).toEqual([{x: 10, y: 10}]);
		expect(controller.pointerDown(tool.pointer(70, 20))).toBe(true);
		controller.pointerUp(tool.pointer(70, 20));
		expect(controller.keyDown({key: 'Escape', modifiers: modifiers()})).toBe(true);
		expect(controller.getOverlayState()?.selectionDraft).toBeUndefined();
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toBeUndefined();
		controller.dispose();
	});

	it('keeps polygonal corners while Space pans with the hand', () => {
		const tool = harness();
		updateLassoToolSettings({kind: 'polygonal'});
		const controller = new ToolController(tool.context);
		controller.activate('lasso');
		const first = tool.pointer(10, 10);
		expect(controller.pointerDown(first)).toBe(true);
		expect(controller.suspendFor('hand')).toBe(false);
		controller.pointerUp(tool.pointer(10, 10));
		expect(controller.suspendFor('hand')).toBe(true);
		expect(controller.toolId).toBe('hand');
		expect(controller.resume()).toBe(true);
		expect(controller.toolId).toBe('lasso');
		expect(controller.getOverlayState()?.selectionDraft?.points).toEqual([{x: 10, y: 10}]);
		expect(controller.pointerDown(tool.pointer(70, 20))).toBe(true);
		expect(controller.getOverlayState()?.selectionDraft?.points).toHaveLength(2);
		controller.dispose();
	});

	it('does not move pixels on Command and cancels when the kind changes', () => {
		const tool = harness();
		trace(tool, square(10, 10, 30));
		const before = tool.document.selections[ACTIVE_SELECTION_ID];
		tool.session.pointerDown(tool.pointer(20, 20, {meta: true}));
		tool.session.pointerMove(tool.pointer(40, 20, {meta: true}));
		tool.session.pointerUp(tool.pointer(40, 20, {meta: true}));
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toEqual(before);
		tool.session.pointerDown(tool.pointer(70, 70));
		tool.session.pointerMove(tool.pointer(90, 70));
		updateLassoToolSettings({kind: 'polygonal'});
		tool.session.sync();
		expect(tool.session.getOverlayState()?.selectionDraft).toBeUndefined();
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toEqual(before);
	});
});

const contextZoom = (tool: ReturnType<typeof harness>, zoom: number) => {
	tool.context.viewport = {
		...tool.context.viewport,
		transform: {...tool.context.viewport.transform, zoom},
		pointsPerPixel: zoom,
	};
};
