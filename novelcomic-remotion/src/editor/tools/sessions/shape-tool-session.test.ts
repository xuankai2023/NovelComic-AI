import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand, type DocumentCommand, type DocumentCommandPayloads, type DocumentCommandType} from '../../commands/document-command-types';
import {createEmptyDocument, createGroupLayer, createShapeLayer} from '../../document/defaults';
import {ACTIVE_SELECTION_ID, selectAllShape, selectionRecord} from '../../document/selection-geometry';
import type {DocumentState, LayerNode, ShapeLayerContent} from '../../document/types';
import {getBrushToolSettings, resetBrushToolSettings, setBrushForeground} from '../brush/brush-settings';
import {SHAPE_PREVIEW_ID} from '../shape/shape-geometry';
import {getShapeSettings, resetShapeSettings, setShapeCornerRadius, setShapeKind, setShapeLineWidth} from '../shape/shape-settings';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {ShapeToolSession} from './shape-tool-session';

const modifiers = (patch: Partial<ToolModifiers> = {}): ToolModifiers => ({
	shift: false,
	alt: false,
	meta: false,
	control: false,
	space: false,
	...patch,
});

const shapeOf = (layer: LayerNode | undefined) => (layer?.content.kind === 'shape' ? layer.content : undefined);

const ordered = (document: DocumentState, parentId: string | null = null) =>
	Object.values(document.layers)
		.filter((layer) => layer.parentId === parentId && layer.id !== SHAPE_PREVIEW_ID)
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

let open: ShapeToolSession | null = null;

const harness = (width = 100, height = 80) => {
	const history = new DocumentCommandHistory();
	let real = createEmptyDocument({width, height, projectId: 'p'});
	const base = createShapeLayer('rectangle', 'Layer 1', width, height);
	base.id = 'layer-1';
	base.order = 0;
	real.layers[base.id] = base;
	real.rootLayerIds = [base.id];
	real.selections[ACTIVE_SELECTION_ID] = selectionRecord(selectAllShape(width, height));
	let preview: DocumentState | null = null;
	const context = {
		get document() {
			return preview ?? real;
		},
		set document(value: DocumentState) {
			real = value;
			preview = null;
		},
		selectedLayerIds: ['layer-1'] as string[],
		activeLayerId: 'layer-1' as string | null,
		viewport: {
			viewport: {width: 800, height: 600},
			document: {width, height},
			transform: {zoom: 1, panX: 0, panY: 0, rotation: 0 as const, devicePixelRatio: 1},
			followsFit: false,
			pointsPerPixel: 1,
		},
		setSelection: (layerId: string) => {
			context.selectedLayerIds = [layerId];
			context.activeLayerId = layerId;
		},
		clearSelection: () => undefined,
		setMovePreview: (next: DocumentState | null) => {
			preview = next;
		},
		commitSelection: () => undefined,
		dispatch: (type: DocumentCommandType, payload: DocumentCommandPayloads[DocumentCommandType]) => {
			real = history.execute(real, createDocumentCommand({type, payload, projectId: real.projectId}));
			preview = null;
		},
		dispatchCommands: (commands: readonly DocumentCommand[]) => {
			real = history.executeTransaction(real, commands);
			preview = null;
		},
		setViewportPan: () => undefined,
		setViewportZoom: () => undefined,
	} as ToolSessionContext;
	open?.dispose();
	const session = new ShapeToolSession(context);
	open = session;
	const pointer = (x: number, y: number, keys: Partial<ToolModifiers> = {}, buttons = 1): ToolPointerEvent => ({
		pointerId: 1,
		pointerType: 'mouse',
		buttons,
		pressure: 1,
		clientPoint: {x, y},
		viewportPoint: {x, y},
		documentPoint: {x, y},
		modifiers: modifiers(keys),
	});
	const drag = (from: {x: number; y: number}, to: {x: number; y: number}, keys: Partial<ToolModifiers> = {}) => {
		session.pointerDown(pointer(from.x, from.y, keys));
		session.pointerMove(pointer(to.x, to.y, keys));
		session.pointerUp(pointer(to.x, to.y, keys, 0));
	};
	return {
		session,
		history,
		context,
		pointer,
		drag,
		get real() {
			return real;
		},
		get preview() {
			return preview;
		},
	};
};

describe('shape tool', () => {
	beforeEach(() => {
		open?.dispose();
		open = null;
		resetShapeSettings();
		resetBrushToolSettings();
		setBrushForeground({r: 255, g: 0, b: 0});
	});

	it('creates a foreground rectangle above the active layer in one undo and keeps the selection', () => {
		const tool = harness();
		tool.drag({x: 10, y: 10}, {x: 40, y: 30}, {control: true});
		const layers = ordered(tool.real);
		expect(layers.map((layer) => layer.name)).toEqual(['Layer 1', 'Rectangle 1']);
		const shape = layers[1]!;
		expect(tool.context.activeLayerId).toBe(shape.id);
		expect(shape.transform).toMatchObject({originX: 10, originY: 10, width: 30, height: 20});
		expect(shapeOf(shape)).toMatchObject({shape: 'rectangle', fill: {r: 255, g: 0, b: 0, a: 1}, cornerRadius: 0, strokeWidth: 0});
		expect(tool.real.selections[ACTIVE_SELECTION_ID]).toBeTruthy();
		expect(tool.history.canUndo).toBe(true);

		tool.drag({x: 60, y: 10}, {x: 70, y: 20}, {control: true});
		expect(ordered(tool.real).map((layer) => layer.name)).toEqual(['Layer 1', 'Rectangle 1', 'Rectangle 2']);
		expect(tool.context.activeLayerId).toBe(ordered(tool.real)[2]!.id);
		const withoutSecond = tool.history.undo(tool.real);
		const withoutFirst = tool.history.undo(withoutSecond);
		expect(Object.values(withoutFirst.layers).map((layer) => layer.name)).toEqual(['Layer 1']);
		expect(withoutFirst.selections[ACTIVE_SELECTION_ID]).toBeTruthy();
	});

	it('draws the preview under layers that already sit above the active one', () => {
		const tool = harness();
		const above = createShapeLayer('rectangle', 'Above', 10, 10);
		above.id = 'above';
		above.order = 1;
		tool.real.layers.above = above;
		tool.real.rootLayerIds = ['layer-1', 'above'];
		tool.session.pointerDown(tool.pointer(10, 10));
		tool.session.pointerMove(tool.pointer(40, 30));
		const preview = tool.preview;
		expect(preview).toBeTruthy();
		expect(tool.real.layers[SHAPE_PREVIEW_ID]).toBeUndefined();
		const ids = Object.values(preview!.layers)
			.filter((layer) => layer.parentId === null)
			.sort((a, b) => a.order - b.order)
			.map((layer) => layer.id);
		expect(ids).toEqual(['layer-1', SHAPE_PREVIEW_ID, 'above']);
		expect(tool.history.canUndo).toBe(false);
	});

	it('makes a circle from the center when Shift and Option are held', () => {
		const tool = harness();
		setShapeKind('ellipse');
		tool.drag({x: 50, y: 40}, {x: 60, y: 45}, {shift: true, alt: true});
		const layer = ordered(tool.real)[1]!;
		expect(layer.name).toBe('Ellipse 1');
		expect(layer.transform).toMatchObject({originX: 40, originY: 30, width: 20, height: 20});
		expect(shapeOf(layer)?.shape).toBe('ellipse');
		expect(shapeOf(layer)?.cornerRadius).toBeUndefined();
	});

	it('makes no layer for a click, Escape, or a tool switch', () => {
		const tool = harness();
		tool.drag({x: 20, y: 20}, {x: 20, y: 20});
		tool.session.pointerDown(tool.pointer(20, 20));
		tool.session.pointerMove(tool.pointer(50, 50));
		expect(tool.preview?.layers[SHAPE_PREVIEW_ID]).toBeTruthy();
		tool.session.pointerCancel('escape');
		expect(tool.preview).toBeNull();
		tool.session.pointerDown(tool.pointer(20, 20));
		tool.session.pointerMove(tool.pointer(50, 50));
		tool.session.pointerCancel('tool-switch');
		expect(Object.values(tool.real.layers)).toHaveLength(1);
		expect(tool.history.canUndo).toBe(false);
		tool.session.dispose();
	});

	it('stores the rectangle radius and steps kinds with Tab and Shift-U', () => {
		const tool = harness();
		setShapeCornerRadius(8);
		tool.drag({x: 10, y: 10}, {x: 50, y: 40});
		expect(shapeOf(ordered(tool.real)[1]!)).toMatchObject({shape: 'rounded-rectangle', cornerRadius: 8});
		setShapeCornerRadius(500);
		tool.drag({x: 55, y: 50}, {x: 95, y: 70});
		expect(shapeOf(ordered(tool.real)[2]!)).toMatchObject({shape: 'rounded-rectangle', cornerRadius: 500});
		tool.session.pointerDown(tool.pointer(5, 5));
		tool.session.pointerMove(tool.pointer(20, 20));
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getShapeSettings().kind).toBe('ellipse');
		expect(tool.preview).toBeNull();
		expect(tool.session.keyDown({key: 'U', modifiers: modifiers({shift: true})})).toBe(true);
		expect(getShapeSettings().kind).toBe('line');
		tool.session.pointerUp(tool.pointer(20, 20, {}, 0));
		expect(ordered(tool.real)).toHaveLength(3);
	});

	it('strokes a line between the dragged points and puts a shape inside the selected folder', () => {
		const tool = harness();
		setShapeKind('line');
		setShapeLineWidth(4);
		tool.drag({x: 10, y: 20}, {x: 40, y: 20}, {control: true});
		const line = shapeOf(ordered(tool.real)[1]!) as ShapeLayerContent;
		expect(line.shape).toBe('line');
		expect(line.strokeWidth).toBe(4);
		expect(line.stroke).toMatchObject({r: 255, g: 0, b: 0, a: 1});
		expect(line.lineStart).toEqual({x: 2 / 34, y: 0.5});
		expect(line.lineEnd).toEqual({x: 32 / 34, y: 0.5});
		expect(ordered(tool.real)[1]!.transform).toMatchObject({originX: 8, originY: 18, width: 34, height: 4});

		const folder = createGroupLayer('Folder');
		folder.id = 'folder';
		const child = createShapeLayer('rectangle', 'Child', 10, 10);
		child.id = 'child';
		child.parentId = 'folder';
		child.order = 0;
		setShapeKind('rectangle');
		folder.order = Math.max(...Object.values(tool.real.layers).map((layer) => layer.order)) + 1;
		tool.real.layers.folder = folder;
		tool.real.layers.child = child;
		tool.real.rootLayerIds = [...tool.real.rootLayerIds, folder.id];
		tool.context.activeLayerId = 'folder';
		tool.context.selectedLayerIds = ['folder'];
		tool.drag({x: 2, y: 2}, {x: 12, y: 8});
		const inside = Object.values(tool.real.layers).find((layer) => layer.name === 'Rectangle 1');
		expect(inside?.parentId).toBe('folder');
		expect(inside!.order).toBeLessThan(tool.real.layers.child!.order);
	});

	it('snaps a corner to the canvas unless Control is held', () => {
		const tool = harness();
		tool.session.pointerDown(tool.pointer(8, 30));
		tool.session.pointerMove(tool.pointer(40, 50));
		const preview = tool.preview?.layers[SHAPE_PREVIEW_ID];
		expect(preview?.transform.originX).toBe(0);
		tool.session.pointerCancel('escape');
		tool.drag({x: 8, y: 30}, {x: 40, y: 50}, {control: true});
		expect(ordered(tool.real)[1]!.transform.originX).toBe(8);
		tool.session.dispose();
	});

	it('refuses a shape past the surface budget and leaves the foreground color alone otherwise', () => {
		const tool = harness();
		tool.drag({x: 0, y: 0}, {x: 20_000, y: 20_000});
		expect(getShapeSettings().error).toBe('That shape is too large. A shape can cover up to 200 megapixels.');
		expect(Object.values(tool.real.layers)).toHaveLength(1);
		expect(tool.history.canUndo).toBe(false);
		expect(getBrushToolSettings().foreground).toEqual({r: 255, g: 0, b: 0});
		tool.session.dispose();
	});
});
