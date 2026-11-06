import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand} from '../../commands/document-command-types';
import {createEmptyDocument} from '../../document/defaults';
import {
	ACTIVE_SELECTION_ID,
	selectionCoverage,
	shapeFromRecord,
} from '../../document/selection-geometry';
import type {DocumentState} from '../../document/types';
import {getMarqueeToolSettings, resetMarqueeToolSettings, updateMarqueeToolSettings} from '../marquee/marquee-settings';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {MarqueeToolSession} from './marquee-tool-session';

const modifiers = (patch: Partial<ToolModifiers> = {}): ToolModifiers => ({
	shift: false,
	alt: false,
	meta: false,
	control: false,
	space: false,
	...patch,
});

const pointer = (x: number, y: number, keys: Partial<ToolModifiers> = {}): ToolPointerEvent => ({
	pointerId: 1,
	pointerType: 'mouse',
	buttons: 1,
	pressure: 1,
	clientPoint: {x, y},
	viewportPoint: {x, y},
	documentPoint: {x, y},
	modifiers: modifiers(keys),
});

const harness = () => {
	const history = new DocumentCommandHistory();
	const context = {
		document: createEmptyDocument({width: 100, height: 100, projectId: 'p'}),
		selectedLayerIds: [],
		activeLayerId: null,
		viewport: {
			viewport: {width: 800, height: 600},
			document: {width: 100, height: 100},
			transform: {zoom: 1, panX: 0, panY: 0, rotation: 0, devicePixelRatio: 1},
			followsFit: false,
			pointsPerPixel: 1,
		},
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
	const session = new MarqueeToolSession(context, 'marquee-rectangle');
	return {
		history,
		session,
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

const drag = (session: MarqueeToolSession, fromX: number, fromY: number, toX: number, toY: number, keys: Partial<ToolModifiers> = {}) => {
	session.pointerDown(pointer(fromX, fromY, keys));
	session.pointerMove(pointer(toX, toY, keys));
	session.pointerUp(pointer(toX, toY, keys));
};

describe('marquee tool session', () => {
	beforeEach(() => resetMarqueeToolSettings());

	it('draws whole-pixel rectangles in any direction and combines them', () => {
		const tool = harness();
		drag(tool.session, 60.4, 70.6, 20.2, 30.3);
		expect(tool.shape()).toEqual({kind: 'rect', bounds: {x: 20, y: 30, width: 40, height: 41}});
		expect(tool.coverage(20, 30)).toBe(255);
		expect(tool.coverage(19, 30)).toBe(0);
		drag(tool.session, 80, 80, 90, 90, {shift: true});
		expect(tool.coverage(85, 85)).toBe(255);
		expect(tool.coverage(40, 50)).toBe(255);
		drag(tool.session, 30, 40, 50, 60, {alt: true});
		expect(tool.coverage(40, 50)).toBe(0);
		expect(tool.coverage(25, 35)).toBe(255);
		drag(tool.session, 5, 5, 5, 5);
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toBeUndefined();
		expect(tool.history.canUndo).toBe(true);
	});

	it('lets a Shift held at the press add, and a fresh Shift square the box', () => {
		const tool = harness();
		drag(tool.session, 5, 5, 15, 15);
		drag(tool.session, 40, 40, 70, 50, {shift: true});
		expect(tool.coverage(10, 10)).toBe(255);
		expect(tool.coverage(65, 45)).toBe(255);
		expect(tool.coverage(65, 60)).toBe(0);
		tool.session.pointerDown(pointer(20, 60, {shift: true}));
		tool.session.pointerMove(pointer(30, 65, {shift: true}));
		tool.session.pointerMove(pointer(35, 68));
		tool.session.pointerMove(pointer(40, 70, {shift: true}));
		tool.session.pointerUp(pointer(40, 70, {shift: true}));
		expect(tool.coverage(30, 75)).toBe(255);
		expect(tool.coverage(65, 45)).toBe(255);
		expect(tool.coverage(10, 10)).toBe(255);
	});

	it('subtracts with Option from the dragged corner', () => {
		const tool = harness();
		drag(tool.session, 0, 0, 100, 100);
		drag(tool.session, 40, 40, 60, 60, {alt: true});
		expect(tool.coverage(50, 50)).toBe(0);
		expect(tool.coverage(30, 30)).toBe(255);
		expect(tool.shape()?.kind).toBe('rects');
	});

	it('selects an oval, and Tab switches the shape without changing the tool', () => {
		const tool = harness();
		updateMarqueeToolSettings({kind: 'ellipse'});
		drag(tool.session, 10, 20, 70, 60);
		expect(tool.coverage(40, 40)).toBe(255);
		expect(tool.coverage(11, 21)).toBe(0);
		tool.session.pointerDown(pointer(20, 20));
		tool.session.pointerMove(pointer(30, 30));
		tool.session.pointerMove(pointer(60, 40, {shift: true}));
		tool.session.pointerUp(pointer(60, 40, {shift: true}));
		expect(tool.shape()).toMatchObject({kind: 'ellipse', bounds: {x: 20, y: 20, width: 40, height: 40}});
		tool.session.keyDown({key: 'Tab', modifiers: modifiers()});
		expect(tool.session.toolId).toBe('marquee-rectangle');
		expect(getMarqueeToolSettings().kind).toBe('rectangle');
	});

	it('moves the outline in whole pixels as one undo and can bring it back from off canvas', () => {
		const tool = harness();
		drag(tool.session, 40, 40, 60, 60, {control: true});
		tool.session.pointerDown(pointer(50, 50, {control: true}));
		tool.session.pointerMove(pointer(25, 50, {control: true}));
		tool.session.pointerUp(pointer(25, 50, {control: true}));
		expect(tool.coverage(30, 50)).toBe(255);
		expect(tool.coverage(55, 50)).toBe(0);
		tool.session.pointerDown(pointer(30, 50, {control: true}));
		tool.session.pointerMove(pointer(55, 50, {control: true}));
		tool.session.pointerUp(pointer(55, 50, {control: true}));
		expect(tool.shape()).toEqual({kind: 'rect', bounds: {x: 40, y: 40, width: 20, height: 20}});
		tool.session.pointerDown(pointer(50, 50, {control: true}));
		tool.session.pointerMove(pointer(90.2, 90.4, {control: true}));
		tool.session.pointerUp(pointer(90.2, 90.4, {control: true}));
		expect(tool.shape()).toEqual({kind: 'rect', bounds: {x: 80, y: 80, width: 20, height: 20}});
		const restored = tool.history.undo(tool.document);
		expect(restored.selections[ACTIVE_SELECTION_ID]?.bounds).toEqual({x: 40, y: 40, width: 20, height: 20});
	});

	it('nudges with the arrow keys and deselects a click inside the selection', () => {
		const tool = harness();
		drag(tool.session, 40, 40, 60, 60, {control: true});
		tool.session.keyDown({key: 'ArrowRight', modifiers: modifiers()});
		tool.session.keyDown({key: 'ArrowUp', modifiers: modifiers({shift: true})});
		expect(tool.shape()).toEqual({kind: 'rect', bounds: {x: 41, y: 30, width: 20, height: 20}});
		tool.session.pointerDown(pointer(50, 40));
		tool.session.pointerMove(pointer(50.2, 40.4));
		tool.session.pointerUp(pointer(50.2, 40.4));
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toBeUndefined();
	});

	it('cancels a draft with Escape and snaps unless Control is held', () => {
		const tool = harness();
		drag(tool.session, 40, 40, 60, 60, {control: true});
		const before = tool.document.selections[ACTIVE_SELECTION_ID];
		tool.session.pointerDown(pointer(70, 40));
		tool.session.pointerMove(pointer(85, 70));
		expect(tool.session.getOverlayState()?.selectionDraft?.bounds).toEqual({x: 70, y: 40, width: 15, height: 30});
		tool.session.keyDown({key: 'Escape', modifiers: modifiers()});
		expect(tool.session.getOverlayState()?.selectionDraft).toBeUndefined();
		expect(tool.document.selections[ACTIVE_SELECTION_ID]).toEqual(before);
		drag(tool.session, 8, 20, 40, 50);
		expect(tool.shape()).toEqual({kind: 'rect', bounds: {x: 0, y: 20, width: 40, height: 30}});
		tool.session.pointerDown(pointer(90, 90));
		tool.session.pointerUp(pointer(90, 90));
		drag(tool.session, 8, 20, 40, 50, {control: true});
		expect(tool.shape()).toEqual({kind: 'rect', bounds: {x: 8, y: 20, width: 32, height: 30}});
	});
});
