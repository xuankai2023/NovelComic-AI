import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand} from '../../commands/document-command-types';
import {createEmptyDocument} from '../../document/defaults';
import {ACTIVE_SELECTION_ID, selectionCoverage, selectionRecord, shapeFromRecord} from '../../document/selection-geometry';
import type {SelectionRecord} from '../../document/types';
import {createPixelBuffer, type PixelBuffer} from '../../pixels/pixel-tools';
import {
	getColorRangeActions,
	getColorRangeSettings,
	rememberColorRangeTool,
	resetColorRangeSettings,
	subscribeColorRangeLeave,
	updateColorRangeSettings,
} from '../color-range/color-range-settings';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {ColorRangeToolSession} from './color-range-tool-session';

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

const harness = (sample: PixelBuffer | null) => {
	const history = new DocumentCommandHistory();
	let leftTo: string | null = null;
	const stop = subscribeColorRangeLeave((tool) => {
		leftTo = tool;
	});
	const context = {
		document: createEmptyDocument({width: sample?.width ?? 8, height: sample?.height ?? 8, projectId: 'p'}),
		selectedLayerIds: [],
		activeLayerId: null,
		viewport: {
			viewport: {width: 800, height: 600},
			document: {width: sample?.width ?? 8, height: sample?.height ?? 8},
			transform: {zoom: 1, panX: 0, panY: 0, rotation: 0, devicePixelRatio: 1},
			followsFit: false,
			pointsPerPixel: 1,
		},
		setSelection: () => undefined,
		clearSelection: () => undefined,
		commitSelection: (selection: SelectionRecord | null) => {
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
	rememberColorRangeTool('move');
	const session = new ColorRangeToolSession(context);
	const covered = (record: SelectionRecord | null | undefined) => {
		const shape = shapeFromRecord(record);
		const hits = new Set<number>();
		const width = sample?.width ?? context.document.width;
		const height = sample?.height ?? context.document.height;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (selectionCoverage(shape, x, y, {antialiased: false}) >= 128) hits.add(y * width + x);
			}
		}
		return hits;
	};
	return {
		history,
		context,
		session,
		preview: () => covered(session.getOverlayState()?.selectionPreview),
		selected: () => covered(context.document.selections[ACTIVE_SELECTION_ID]),
		leftTo: () => leftTo,
		stop,
	};
};

const click = (session: ColorRangeToolSession, x: number, y: number, keys: Partial<ToolModifiers> = {}) => {
	session.pointerDown(pointer(x, y, keys));
	session.pointerUp(pointer(x, y, keys));
};

describe('color range tool', () => {
	let open: ReturnType<typeof harness> | null = null;
	beforeEach(() => resetColorRangeSettings());
	afterEach(() => {
		open?.session.dispose();
		open?.stop();
		open = null;
	});

	it('previews sampled colors and writes one undo step on OK', () => {
		const halves = paint(20, 10, (x) => (x < 10 ? red : blue));
		const tool = (open = harness(halves));
		click(tool.session, 2, 2);
		expect(tool.preview().size).toBe(100);
		expect(tool.history.canUndo).toBe(false);
		click(tool.session, 15, 5, {shift: true});
		expect(tool.preview().size).toBe(200);
		click(tool.session, 2, 2, {alt: true});
		expect([...tool.preview()].every((index) => index % 20 >= 10)).toBe(true);
		getColorRangeActions()?.commit();
		expect(tool.selected().size).toBe(100);
		expect(tool.history.canUndo).toBe(true);
		expect(tool.leftTo()).toBe('move');
	});

	it('puts the previous selection back on Escape', () => {
		const tool = (open = harness(paint(8, 8, () => red)));
		tool.context.commitSelection(selectionRecord({kind: 'rect', bounds: {x: 0, y: 0, width: 2, height: 2}}));
		const before = tool.context.document.selections[ACTIVE_SELECTION_ID];
		click(tool.session, 1, 1);
		expect(tool.preview().size).toBe(64);
		tool.session.pointerCancel('escape');
		expect(tool.context.document.selections[ACTIVE_SELECTION_ID]).toBe(before);
		expect(tool.leftTo()).toBe('move');
	});

	it('widens the preview when fuzziness grows', () => {
		const row = paint(6, 1, (x) => (x < 3 ? red : x === 3 ? [200, 0, 0, 255] : blue));
		const tool = (open = harness(row));
		updateColorRangeSettings({fuzziness: 0});
		click(tool.session, 1.5, 0.2);
		expect(tool.preview()).toEqual(new Set([0, 1, 2]));
		updateColorRangeSettings({fuzziness: 55});
		expect(tool.preview()).toEqual(new Set([0, 1, 2, 3]));
	});

	it('leaves the selection alone when the pixels cannot be read', () => {
		const tool = (open = harness(null));
		click(tool.session, 1, 1);
		expect(getColorRangeSettings().error).toBe('还读不到图层像素。');
		expect(tool.session.getOverlayState()?.selectionPreview).toBeUndefined();
		getColorRangeActions()?.commit();
		expect(tool.history.canUndo).toBe(false);
	});
});
