import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import type {DocumentCommand} from '../../commands/document-command-types';
import {createEmptyDocument, createShapeLayer} from '../../document/defaults';
import type {DocumentState, LayerNode} from '../../document/types';
import {
	getMoveToolSettings,
	resetMoveToolSettings,
	updateMoveToolSettings,
} from '../move/move-tool-settings';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {MoveToolSession} from './move-tool-session';

const modifiers = (patch: Partial<ToolModifiers> = {}): ToolModifiers => ({
	shift: false,
	alt: false,
	meta: false,
	control: false,
	space: false,
	...patch,
});

const pointer = (
	x: number,
	y: number,
	keys: Partial<ToolModifiers> = {},
): ToolPointerEvent => ({
	pointerId: 1,
	pointerType: 'mouse',
	buttons: 1,
	pressure: 1,
	clientPoint: {x, y},
	viewportPoint: {x, y},
	documentPoint: {x, y},
	modifiers: modifiers(keys),
});

const add = (document: DocumentState, layer: LayerNode, order: number) => {
	layer.order = order;
	layer.parentId = null;
	document.layers[layer.id] = layer;
	document.rootLayerIds = [...document.rootLayerIds, layer.id];
	return layer;
};

const harness = (document: DocumentState, selected: string[]) => {
	const history = new DocumentCommandHistory();
	let selectedIds = [...selected];
	const context: ToolSessionContext = {
		document,
		selectedLayerIds: selectedIds,
		activeLayerId: selectedIds.at(-1) ?? null,
		viewport: {
			viewport: {width: 800, height: 600},
			document: {width: document.width, height: document.height},
			transform: {zoom: 1, panX: 0, panY: 0, rotation: 0, devicePixelRatio: 1},
			followsFit: false,
			pointsPerPixel: 1,
		},
		setSelection: () => undefined,
		clearSelection: () => undefined,
		setSelectedIds: (ids) => {
			selectedIds = [...ids];
			context.selectedLayerIds = selectedIds;
			context.activeLayerId = selectedIds.at(-1) ?? null;
		},
		setMovePreview: () => undefined,
		commitSelection: () => undefined,
		dispatch: () => undefined,
		dispatchCommands: (commands: readonly DocumentCommand[]) => {
			context.document = history.executeTransaction(context.document, commands);
		},
		setViewportPan: () => undefined,
		setViewportZoom: () => undefined,
	};
	return {
		history,
		session: new MoveToolSession(context),
		get document() {
			return context.document;
		},
		get selectedIds() {
			return [...selectedIds];
		},
	};
};

describe('move tool session', () => {
	beforeEach(() => resetMoveToolSettings());

	it('drags the active layer from outside its box and does not clear the selection', () => {
		const document = createEmptyDocument({width: 400, height: 300, projectId: 'p'});
		const layer = add(
			document,
			createShapeLayer('rectangle', 'Layer', 100, 100),
			0,
		);
		layer.transform = {...layer.transform, originX: 150, originY: 100};
		const tool = harness(document, [layer.id]);
		tool.session.pointerDown(pointer(0, 0, {control: true}));
		tool.session.pointerMove(pointer(20, 10, {control: true}));
		tool.session.pointerUp(pointer(20, 10, {control: true}));
		expect(tool.document.layers[layer.id]?.transform.originX).toBe(170);
		expect(tool.document.layers[layer.id]?.transform.originY).toBe(110);
		expect(tool.selectedIds).toEqual([layer.id]);
	});

	it('duplicates on option-drag, undoes the copy, and drops it when cancelled', () => {
		const document = createEmptyDocument({width: 400, height: 300, projectId: 'p'});
		const layer = add(
			document,
			createShapeLayer('rectangle', 'Layer', 100, 100),
			0,
		);
		layer.transform = {...layer.transform, originX: 150, originY: 100};
		const committed = harness(document, [layer.id]);
		committed.session.pointerDown(pointer(0, 0, {alt: true, control: true}));
		committed.session.pointerMove(pointer(20, 10, {alt: true, control: true}));
		committed.session.pointerUp(pointer(20, 10, {alt: true, control: true}));
		const layers = Object.values(committed.document.layers);
		expect(layers).toHaveLength(2);
		expect(committed.document.layers[layer.id]?.transform.originX).toBe(150);
		const copy = layers.find((item) => item.id !== layer.id);
		expect(copy?.transform.originX).toBe(170);
		expect(copy?.transform.originY).toBe(110);
		const undone = committed.history.undo(committed.document);
		expect(Object.keys(undone.layers)).toEqual([layer.id]);

		const cancelled = harness(
			structuredClone(document),
			[layer.id],
		);
		cancelled.session.pointerDown(pointer(0, 0, {alt: true, control: true}));
		cancelled.session.pointerMove(pointer(20, 10, {alt: true, control: true}));
		cancelled.session.pointerCancel('escape');
		expect(cancelled.history.canUndo).toBe(false);
		expect(Object.keys(cancelled.document.layers)).toEqual([layer.id]);
		expect(cancelled.document.layers[layer.id]?.transform.originX).toBe(150);
	});

	it('does not round a transform when the pointer never moves', () => {
		const document = createEmptyDocument({width: 400, height: 300, projectId: 'p'});
		const layer = add(document, createShapeLayer('rectangle', 'Layer', 100, 100), 0);
		layer.transform = {...layer.transform, originX: 150.4, originY: 100.2};
		const tool = harness(document, [layer.id]);
		tool.session.pointerDown(pointer(0, 0, {control: true}));
		tool.session.pointerUp(pointer(0, 0, {control: true}));
		expect(tool.history.canUndo).toBe(false);
		expect(tool.document.layers[layer.id]?.transform.originX).toBe(150.4);
	});

	it('uses Command to flip auto-select and Command-Shift to add', () => {
		const document = createEmptyDocument({width: 400, height: 300, projectId: 'p'});
		const blue = add(document, createShapeLayer('rectangle', 'Blue', 400, 300), 0);
		const red = add(document, createShapeLayer('rectangle', 'Red', 100, 100), 1);
		red.transform = {...red.transform, originX: 150, originY: 100};
		expect(getMoveToolSettings().autoSelect).toBe(false);
		const flipped = harness(structuredClone(document), [blue.id]);
		flipped.session.pointerDown(pointer(200, 150, {meta: true, control: true}));
		flipped.session.pointerUp(pointer(200, 150, {meta: true, control: true}));
		expect(flipped.selectedIds).toEqual([red.id]);
		expect(getMoveToolSettings().autoSelect).toBe(false);

		updateMoveToolSettings({autoSelect: true});
		const added = harness(structuredClone(document), [blue.id]);
		added.session.pointerDown(
			pointer(200, 150, {meta: true, shift: true, control: true}),
		);
		added.session.pointerUp(
			pointer(200, 150, {meta: true, shift: true, control: true}),
		);
		expect(new Set(added.selectedIds)).toEqual(new Set([blue.id, red.id]));

		const foreground = harness(structuredClone(document), [blue.id]);
		foreground.session.pointerDown(pointer(200, 150, {control: true}));
		foreground.session.pointerUp(pointer(200, 150, {control: true}));
		expect(foreground.selectedIds).toEqual([red.id]);
	});

	it('resizes from the east handle without moving the opposite edge', () => {
		const document = createEmptyDocument({width: 400, height: 300, projectId: 'p'});
		const layer = add(document, createShapeLayer('rectangle', 'Layer', 100, 100), 0);
		const tool = harness(document, [layer.id]);
		tool.session.pointerDown(pointer(100, 50, {shift: true, control: true}));
		tool.session.pointerMove(pointer(140, 50, {shift: true, control: true}));
		tool.session.pointerUp(pointer(140, 50, {shift: true, control: true}));
		const next = tool.document.layers[layer.id]?.transform;
		expect(next?.originX).toBe(0);
		expect(next?.originY).toBe(0);
		expect(Math.abs((next?.width ?? 0) * (next?.scaleX ?? 0))).toBe(140);
		expect(Math.abs((next?.height ?? 0) * (next?.scaleY ?? 0))).toBe(100);
	});

	it('snaps to the canvas unless Control is held', () => {
		const document = createEmptyDocument({width: 400, height: 300, projectId: 'p'});
		const layer = add(document, createShapeLayer('rectangle', 'Layer', 100, 100), 0);
		layer.transform = {...layer.transform, originX: 20, originY: 40};
		const snapped = harness(structuredClone(document), [layer.id]);
		snapped.session.pointerDown(pointer(0, 0));
		snapped.session.pointerMove(pointer(-14, 0));
		snapped.session.pointerUp(pointer(-14, 0));
		expect(snapped.document.layers[layer.id]?.transform.originX).toBe(0);

		const free = harness(structuredClone(document), [layer.id]);
		free.session.pointerDown(pointer(0, 0, {control: true}));
		free.session.pointerMove(pointer(-14, 0, {control: true}));
		free.session.pointerUp(pointer(-14, 0, {control: true}));
		expect(free.document.layers[layer.id]?.transform.originX).toBe(6);
	});
});
