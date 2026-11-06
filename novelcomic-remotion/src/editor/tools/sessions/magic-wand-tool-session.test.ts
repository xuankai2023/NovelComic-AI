import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand} from '../../commands/document-command-types';
import {createEmptyDocument} from '../../document/defaults';
import {ACTIVE_SELECTION_ID, selectionCoverage, selectionRecord, selectAllShape, shapeFromRecord} from '../../document/selection-geometry';
import type {DocumentState} from '../../document/types';
import {createPixelBuffer, type PixelBuffer} from '../../pixels/pixel-tools';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {getWandToolSettings, resetWandToolSettings, updateWandToolSettings} from '../wand/wand-settings';
import {MagicWandToolSession} from './magic-wand-tool-session';

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

const red: [number, number, number, number] = [255, 0, 0, 255];
const blue: [number, number, number, number] = [0, 0, 255, 255];

const paint = (width: number, height: number, color: (x: number, y: number) => [number, number, number, number]): PixelBuffer => {
	const buffer = createPixelBuffer(width, height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) buffer.data.set(color(x, y), (y * width + x) * 4);
	}
	return buffer;
};

const harness = (sample: PixelBuffer) => {
	const history = new DocumentCommandHistory();
	const context = {
		document: createEmptyDocument({width: sample.width, height: sample.height, projectId: 'p'}),
		selectedLayerIds: [],
		activeLayerId: null,
		viewport: {
			viewport: {width: 800, height: 600},
			document: {width: sample.width, height: sample.height},
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
		readWandSample: () => sample,
	} as ToolSessionContext;
	const session = new MagicWandToolSession(context);
	const selected = () => {
		const shape = shapeFromRecord(context.document.selections[ACTIVE_SELECTION_ID]);
		const hits = new Set<number>();
		for (let y = 0; y < sample.height; y++) {
			for (let x = 0; x < sample.width; x++) {
				if (selectionCoverage(shape, x, y, {antialiased: false}) >= 128) hits.add(y * sample.width + x);
			}
		}
		return hits;
	};
	return {
		history,
		context,
		session,
		selected,
		undo() {
			context.document = history.undo(context.document);
		},
	};
};

const click = (session: MagicWandToolSession, x: number, y: number, keys: Partial<ToolModifiers> = {}) => {
	session.pointerDown(pointer(x, y, keys));
	session.pointerUp(pointer(x, y, keys));
};

describe('magic wand tool', () => {
	beforeEach(() => resetWandToolSettings());

	it('selects the active sample, then adds and subtracts as separate undo steps', () => {
		const halves = paint(20, 10, (x) => (x < 10 ? red : blue));
		const tool = harness(halves);
		click(tool.session, 2, 2);
		expect(tool.selected().size).toBe(100);
		expect(tool.history.canUndo).toBe(true);
		click(tool.session, 15, 5, {shift: true});
		expect(tool.selected().size).toBe(200);
		click(tool.session, 2, 2, {alt: true});
		const right = new Set<number>();
		for (let index = 0; index < 200; index++) if (index % 20 >= 10) right.add(index);
		expect(tool.selected()).toEqual(right);
		tool.undo();
		expect(tool.selected().size).toBe(200);
	});

	it('selects the whole canvas when the sample is transparent', () => {
		const tool = harness(createPixelBuffer(20, 10));
		click(tool.session, 2, 2);
		expect(tool.selected().size).toBe(200);
	});

	it('makes a new selection when a click inside does not move the outline', () => {
		const halves = paint(20, 10, (x) => (x < 10 ? red : blue));
		const tool = harness(halves);
		tool.context.commitSelection(selectionRecord(selectAllShape(20, 10)));
		click(tool.session, 3.5, 5.5);
		expect(tool.context.document.selections[ACTIVE_SELECTION_ID]).toBeTruthy();
		expect(tool.selected().size).toBe(100);
		expect([...tool.selected()].every((index) => index % 20 < 10)).toBe(true);
	});

	it('drags the outline instead of sampling again', () => {
		const halves = paint(20, 10, (x) => (x < 10 ? red : blue));
		const tool = harness(halves);
		click(tool.session, 2, 2);
		tool.session.pointerDown(pointer(2, 2));
		tool.session.pointerMove(pointer(12, 2, {control: true}));
		tool.session.pointerUp(pointer(12, 2, {control: true}));
		expect([...tool.selected()].every((index) => index % 20 >= 10)).toBe(true);
		expect(tool.selected().size).toBe(100);
	});

	it('leaves the selection alone when the pixels cannot be read', () => {
		const tool = harness(paint(8, 8, () => red));
		click(tool.session, 1, 1);
		expect(tool.selected().size).toBe(64);
		tool.context.readWandSample = () => null;
		click(tool.session, 1, 1);
		expect(tool.selected().size).toBe(64);
		expect(getWandToolSettings().error).toBe('还读不到图层像素。');
	});

	it('clears a new selection when the seed does not match, and keeps it for add', () => {
		const dot = paint(5, 5, (x, y) => (x === 2 && y === 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
		const tool = harness(dot);
		updateWandToolSettings({sampleSize: 'three', tolerance: 0, contiguous: true});
		click(tool.session, 0.5, 0.5);
		expect(tool.selected().size).toBeGreaterThan(0);
		click(tool.session, 2.5, 2.5);
		expect(tool.context.document.selections[ACTIVE_SELECTION_ID]).toBeUndefined();
		click(tool.session, 0.5, 0.5);
		click(tool.session, 2.5, 2.5, {shift: true});
		expect(tool.selected().size).toBeGreaterThan(0);
	});
});
