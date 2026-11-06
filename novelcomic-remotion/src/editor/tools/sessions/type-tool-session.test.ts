import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand, type DocumentCommand, type DocumentCommandPayloads, type DocumentCommandType} from '../../commands/document-command-types';
import {createEmptyDocument, createTextLayer} from '../../document/defaults';
import {ACTIVE_SELECTION_ID, selectAllShape, selectionRecord} from '../../document/selection-geometry';
import type {DocumentState, LayerNode} from '../../document/types';
import {resetBrushToolSettings, setBrushForeground} from '../brush/brush-settings';
import {queueLiveTextEdit, replaceTypeText, resetTypeEditorState, getTypeDraft} from '../type/type-settings';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {MoveToolSession} from './move-tool-session';
import {TypeToolSession} from './type-tool-session';

const modifiers = (patch: Partial<ToolModifiers> = {}): ToolModifiers => ({
	shift: false,
	alt: false,
	meta: false,
	control: false,
	space: false,
	...patch,
});

const textOf = (layer: LayerNode | undefined) => (layer?.content.kind === 'text' ? layer.content : undefined);

let open: TypeToolSession | null = null;

const harness = () => {
	const history = new DocumentCommandHistory();
	let real = createEmptyDocument({width: 400, height: 300, projectId: 'p'});
	real.selections[ACTIVE_SELECTION_ID] = selectionRecord(selectAllShape(400, 300));
	let preview: DocumentState | null = null;
	const switched: string[] = [];
	const context = {
		get document() {
			return preview ?? real;
		},
		selectedLayerIds: [] as string[],
		activeLayerId: null as string | null,
		viewport: {
			viewport: {width: 800, height: 600},
			document: {width: 400, height: 300},
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
		setTool: (toolId: string) => {
			switched.push(toolId);
		},
	} as ToolSessionContext;
	open?.dispose();
	const session = new TypeToolSession(context);
	open = session;
	const pointer = (x: number, y: number, keys: Partial<ToolModifiers> = {}, buttons = 1, clickCount = 1): ToolPointerEvent => ({
		pointerId: 1,
		pointerType: 'mouse',
		buttons,
		pressure: 1,
		clickCount,
		clientPoint: {x, y},
		viewportPoint: {x, y},
		documentPoint: {x, y},
		modifiers: modifiers(keys),
	});
	const click = (x: number, y: number) => {
		session.pointerDown(pointer(x, y));
		session.pointerUp(pointer(x, y, {}, 0));
	};
	const drag = (from: {x: number; y: number}, to: {x: number; y: number}) => {
		session.pointerDown(pointer(from.x, from.y));
		session.pointerMove(pointer(to.x, to.y));
		session.pointerUp(pointer(to.x, to.y, {}, 0));
	};
	return {
		session,
		history,
		context,
		pointer,
		click,
		drag,
		switched,
		get real() {
			return real;
		},
		get preview() {
			return preview;
		},
	};
};

const seedText = (tool: ReturnType<typeof harness>, text = 'Hello') => {
	const layer = createTextLayer(text, text, 200, 80);
	layer.id = 'text-1';
	layer.order = 0;
	layer.content = {
		kind: 'text',
		text,
		fontFamily: 'Helvetica',
		fontSize: 32,
		color: {r: 0, g: 0, b: 0, a: 1},
		align: 'left',
		lineHeight: 1.2,
		letterSpacing: 0,
		leading: 0,
	};
	layer.transform = {...layer.transform, originX: 0, originY: 0, width: 200, height: 80};
	tool.real.layers[layer.id] = layer;
	tool.real.rootLayerIds = [layer.id];
	tool.context.setSelection(layer.id);
	return layer;
};

describe('type tool', () => {
	beforeEach(() => {
		open?.dispose();
		open = null;
		resetTypeEditorState();
		resetBrushToolSettings();
		setBrushForeground({r: 255, g: 0, b: 0});
	});

	it('opens a point-text draft on click and drops it on Escape', () => {
		const tool = harness();
		tool.click(100, 100);
		const draft = getTypeDraft();
		expect(draft?.layerId).toBeNull();
		expect(draft?.style.boxSize).toBeNull();
		expect(draft?.style.leading).toBe(0);
		expect(tool.history.canUndo).toBe(false);
		expect(Object.keys(tool.real.layers)).toHaveLength(0);
		tool.session.pointerCancel('escape');
		expect(getTypeDraft()).toBeNull();
		expect(Object.keys(tool.real.layers)).toHaveLength(0);
	});

	it('commits typed point text as one undoable layer and keeps the marquee', () => {
		const tool = harness();
		tool.click(100, 100);
		expect(replaceTypeText('Hi', 2, 2)).toBe(true);
		expect(tool.session.keyDown({key: 'Enter', modifiers: modifiers({meta: true})})).toBe(true);
		const layer = Object.values(tool.real.layers).find((item) => item.kind === 'text');
		expect(textOf(layer)).toMatchObject({text: 'Hi', fontFamily: 'Helvetica', fontSize: 72, leading: 0, color: {r: 255, g: 0, b: 0, a: 1}});
		expect(textOf(layer)?.boxSize).toBeUndefined();
		expect(layer?.name).toBe('Hi');
		expect(tool.real.selections[ACTIVE_SELECTION_ID]).toBeTruthy();
		expect(tool.history.canUndo).toBe(true);
		const undone = tool.history.undo(tool.real);
		expect(Object.values(undone.layers).some((item) => item.kind === 'text')).toBe(false);
	});

	it('commits whitespace as nothing and leaves the defaults alone', () => {
		const tool = harness();
		tool.click(100, 100);
		replaceTypeText('   ', 3, 3);
		tool.session.keyDown({key: 'Enter', modifiers: modifiers({control: true})});
		expect(Object.keys(tool.real.layers)).toHaveLength(0);
		expect(tool.history.canUndo).toBe(false);
		expect(getTypeDraft()).toBeNull();
	});

	it('drags a paragraph box from the pointer', () => {
		const tool = harness();
		tool.drag({x: 10, y: 10}, {x: 200, y: 120});
		const draft = getTypeDraft();
		expect(draft?.style.boxSize).toEqual({width: 190, height: 110});
		expect(draft?.originX).toBe(10);
		expect(draft?.originY).toBe(10);
		expect(draft?.width).toBe(190);
		expect(draft?.height).toBe(110);
	});

	it('edits the text under the pointer instead of making a second layer', () => {
		const tool = harness();
		const layer = seedText(tool);
		tool.click(20, 20);
		expect(getTypeDraft()?.layerId).toBe(layer.id);
		expect(Object.keys(tool.real.layers)).toEqual([layer.id]);
		expect(replaceTypeText('Hello!', 6, 6)).toBe(true);
		tool.session.keyDown({key: 'Enter', modifiers: modifiers({meta: true})});
		expect(Object.keys(tool.real.layers)).toEqual([layer.id]);
		expect(textOf(tool.real.layers[layer.id])).toMatchObject({text: 'Hello!'});
		expect(tool.history.canUndo).toBe(true);
		const undone = tool.history.undo(tool.real);
		expect(textOf(undone.layers[layer.id])).toMatchObject({text: 'Hello'});
	});

	it('does not record history when the edit is unchanged', () => {
		const tool = harness();
		seedText(tool);
		tool.click(20, 20);
		tool.session.keyDown({key: 'Enter', modifiers: modifiers({meta: true})});
		expect(tool.history.canUndo).toBe(false);
		expect(getTypeDraft()).toBeNull();
	});

	it('commits the draft when the tool switches', () => {
		const tool = harness();
		tool.click(100, 100);
		replaceTypeText('Hi', 2, 2);
		tool.session.pointerCancel('tool-switch');
		expect(getTypeDraft()).toBeNull();
		expect(Object.values(tool.real.layers).some((layer) => textOf(layer)?.text === 'Hi')).toBe(true);
		expect(tool.history.canUndo).toBe(true);
	});

	it('nudges tracking with Option-Left', () => {
		const tool = harness();
		tool.click(100, 100);
		expect(tool.session.keyDown({key: 'ArrowLeft', modifiers: modifiers({alt: true})})).toBe(true);
		expect(getTypeDraft()?.style.tracking).toBe(-1);
	});

	it('opens a queued live-text layer when the session starts', () => {
		const tool = harness();
		const layer = seedText(tool);
		tool.session.dispose();
		open = null;
		queueLiveTextEdit(layer.id);
		const next = new TypeToolSession(tool.context);
		open = next;
		expect(getTypeDraft()?.layerId).toBe(layer.id);
	});

	it('double-clicking text with the move tool queues a type edit', () => {
		const tool = harness();
		const layer = seedText(tool);
		tool.session.dispose();
		open = null;
		const move = new MoveToolSession(tool.context);
		move.pointerDown(tool.pointer(20, 20, {}, 1, 2));
		expect(tool.switched).toEqual(['type']);
		expect(tool.context.activeLayerId).toBe(layer.id);
		const next = new TypeToolSession(tool.context);
		open = next;
		expect(getTypeDraft()?.layerId).toBe(layer.id);
		move.dispose();
	});
});
