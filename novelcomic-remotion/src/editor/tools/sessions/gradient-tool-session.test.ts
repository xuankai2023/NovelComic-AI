import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand, type DocumentCommand, type DocumentCommandPayloads, type DocumentCommandType} from '../../commands/document-command-types';
import {createEmptyDocument, createPixelLayer} from '../../document/defaults';
import {ACTIVE_SELECTION_ID} from '../../document/selection-geometry';
import type {AssetRecord} from '../../document/types';
import {createPixelBuffer} from '../../pixels/pixel-tools';
import {brushPreviewPixels, brushSourcePixels, rememberBrushPixels, resetBrushPixels} from '../brush/brush-pixels';
import {getBrushToolSettings, resetBrushToolSettings, setBrushBackground, setBrushForeground} from '../brush/brush-settings';
import {documentToViewport} from '../coordinates';
import {dismissPendingGradient, getGradientPending, getGradientSettings, resetGradientSettings, setGradientReverse, setGradientStyle, updateGradientSettings} from '../gradient/gradient-settings';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {GradientToolSession} from './gradient-tool-session';

const modifiers = (patch: Partial<ToolModifiers> = {}): ToolModifiers => ({
	shift: false,
	alt: false,
	meta: false,
	control: false,
	space: false,
	...patch,
});

const raster = (id: string, width: number, height: number): AssetRecord => ({
	id,
	kind: 'raster',
	originalName: `${id}.png`,
	mimeType: 'image/png',
	width,
	height,
	byteSize: width * height * 4,
	objectKey: `memory://${id}`,
	contentHash: id,
});

const filled = (width: number, height: number, color: readonly [number, number, number, number]) => {
	const buffer = createPixelBuffer(width, height, color);
	return buffer;
};

const harness = (color: readonly [number, number, number, number] = [255, 255, 255, 255]) => {
	const history = new DocumentCommandHistory();
	const document = createEmptyDocument({width: 40, height: 20, projectId: 'p'});
	const layer = createPixelLayer('asset-1', 'Surface', 40, 20);
	layer.id = 'layer-1';
	document.layers[layer.id] = layer;
	document.rootLayerIds = [layer.id];
	document.assets['asset-1'] = raster('asset-1', 40, 20);
	rememberBrushPixels('asset-1', filled(40, 20, color));
	const viewport = {
		viewport: {width: 800, height: 600},
		document: {width: 40, height: 20},
		transform: {zoom: 1, panX: 0, panY: 0, rotation: 0 as const, devicePixelRatio: 1},
		followsFit: false,
		pointsPerPixel: 1,
	};
	const context = {
		document,
		selectedLayerIds: [layer.id],
		activeLayerId: layer.id,
		viewport,
		setSelection: () => undefined,
		clearSelection: () => undefined,
		commitSelection: () => undefined,
		dispatch: (type: DocumentCommandType, payload: DocumentCommandPayloads[DocumentCommandType]) => {
			context.document = history.execute(context.document, createDocumentCommand({type, payload, projectId: context.document.projectId}));
		},
		dispatchCommands: (commands: readonly DocumentCommand[]) => {
			context.document = history.executeTransaction(context.document, commands);
		},
		setViewportPan: () => undefined,
		setViewportZoom: () => undefined,
	} as ToolSessionContext;
	const session = new GradientToolSession(context);
	const pointer = (x: number, y: number, keys: Partial<ToolModifiers> = {}): ToolPointerEvent => {
		const documentPoint = {x, y};
		return {
			pointerId: 1,
			pointerType: 'mouse',
			buttons: 1,
			pressure: 1,
			clickCount: 1,
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
		layer,
		assetId() {
			const content = context.document.layers[layer.id]?.content;
			return content?.kind === 'pixel' ? content.assetId : '';
		},
		channels(x: number, y: number) {
			const pixels = brushSourcePixels(this.assetId());
			if (!pixels) return [];
			const offset = (y * pixels.width + x) * 4;
			return [pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2], pixels.data[offset + 3]];
		},
	};
};

const drag = (tool: ReturnType<typeof harness>, from: {x: number; y: number}, to: {x: number; y: number}, keys: Partial<ToolModifiers> = {}) => {
	tool.session.pointerDown(tool.pointer(from.x, from.y, keys));
	tool.session.pointerMove(tool.pointer(to.x, to.y, keys));
	tool.session.pointerUp(tool.pointer(to.x, to.y, keys));
};

describe('gradient tool session', () => {
	beforeEach(() => {
		resetBrushToolSettings();
		resetBrushPixels();
		resetGradientSettings();
		setBrushForeground({r: 0, g: 0, b: 0});
		setBrushBackground({r: 255, g: 255, b: 255});
	});

	it('previews the drag and commits one undo on Enter', () => {
		const tool = harness();
		setGradientStyle('foreground-to-background');
		const before = tool.assetId();
		drag(tool, {x: 0.5, y: 4}, {x: 10.5, y: 4});
		expect(tool.assetId()).toBe(before);
		expect(tool.session.status).toBe('active');
		const preview = brushPreviewPixels('asset-1');
		expect(preview?.data[(4 * 40 + 0) * 4]).toBe(0);
		expect(preview?.data[(4 * 40 + 5) * 4]).toBe(128);
		expect(tool.session.getOverlayState()?.gradient?.end).toEqual({x: 10.5, y: 4});
		expect(tool.session.keyDown({key: 'Enter', modifiers: modifiers()})).toBe(true);
		expect(tool.assetId()).not.toBe(before);
		expect(tool.history.canUndo).toBe(true);
		expect(tool.channels(0, 4)).toEqual([0, 0, 0, 255]);
		expect(tool.channels(5, 4)).toEqual([128, 128, 128, 255]);
		expect(tool.channels(10, 4)).toEqual([255, 255, 255, 255]);
		expect(brushPreviewPixels('asset-1')).toBeUndefined();
		tool.context.document = tool.history.undo(tool.context.document);
		expect(tool.assetId()).toBe(before);
		tool.session.dispose();
	});

	it('drops the draft on Escape and keeps a line when the pointer is cancelled mid-drag', () => {
		const tool = harness([255, 0, 0, 255]);
		drag(tool, {x: 0.5, y: 2}, {x: 20.5, y: 2});
		expect(brushPreviewPixels('asset-1')).toBeTruthy();
		tool.session.pointerCancel('escape');
		expect(tool.session.getOverlayState()?.gradient ?? null).toBeNull();
		expect(brushPreviewPixels('asset-1')).toBeUndefined();
		expect(tool.history.canUndo).toBe(false);
		expect(tool.channels(0, 2)).toEqual([255, 0, 0, 255]);
		tool.session.pointerDown(tool.pointer(1, 2));
		tool.session.pointerMove(tool.pointer(12, 2));
		tool.session.pointerCancel('pointercancel');
		expect(tool.history.canUndo).toBe(false);
		expect(tool.session.getOverlayState()?.gradient?.end).toEqual({x: 12, y: 2});
		expect(brushPreviewPixels('asset-1')).toBeTruthy();
		tool.session.pointerCancel('escape');
		tool.session.dispose();
	});

	it('keeps a finished line when pointer capture is released', () => {
		const tool = harness();
		drag(tool, {x: 0.5, y: 3}, {x: 8.5, y: 3});
		tool.session.pointerCancel('lostpointercapture');
		expect(tool.session.status).toBe('active');
		expect(tool.session.getOverlayState()?.gradient?.end).toEqual({x: 8.5, y: 3});
		tool.session.dispose();
	});

	it('drags an end, snaps to 45 degrees, and refuses a click that never moved', () => {
		const tool = harness();
		drag(tool, {x: 2, y: 6}, {x: 16, y: 6});
		tool.session.pointerDown(tool.pointer(16, 6));
		tool.session.pointerMove(tool.pointer(16, 14));
		tool.session.pointerUp(tool.pointer(16, 14));
		expect(tool.session.getOverlayState()?.gradient).toMatchObject({start: {x: 2, y: 6}, end: {x: 16, y: 14}});
		tool.session.pointerCancel('escape');
		drag(tool, {x: 10, y: 10}, {x: 20, y: 11}, {shift: true});
		const end = tool.session.getOverlayState()?.gradient?.end;
		expect(end?.y).toBeCloseTo(10, 4);
		expect(end?.x).toBeCloseTo(10 + Math.hypot(10, 1), 4);
		tool.session.pointerCancel('escape');
		tool.session.pointerDown(tool.pointer(4, 18));
		tool.session.pointerUp(tool.pointer(4, 18));
		expect(tool.session.keyDown({key: 'Enter', modifiers: modifiers()})).toBe(false);
		expect(tool.assetId()).toBe('asset-1');
		expect(tool.history.canUndo).toBe(false);
		expect(getGradientPending()).toBe(false);
		tool.session.dispose();
	});

	it('switches shape with Tab, fades to transparent, and stays inside the selection', () => {
		const tool = harness([0, 0, 255, 255]);
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getGradientSettings().shape).toBe('radial');
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getGradientSettings().shape).toBe('linear');
		setGradientStyle('foreground-to-transparent');
		drag(tool, {x: 0.5, y: 1}, {x: 8.5, y: 1});
		tool.session.keyDown({key: 'Enter', modifiers: modifiers()});
		expect(tool.channels(0, 1)).toEqual([0, 0, 0, 255]);
		expect(tool.channels(8, 1)).toEqual([0, 0, 255, 255]);
		tool.context.document = tool.history.undo(tool.context.document);
		tool.context.document.selections[ACTIVE_SELECTION_ID] = {
			id: ACTIVE_SELECTION_ID,
			bounds: {x: 0, y: 0, width: 6, height: 20},
			feather: 0,
			geometry: {antialiased: false, shape: {kind: 'rect', bounds: {x: 0, y: 0, width: 6, height: 20}}},
		};
		setBrushForeground({r: 255, g: 255, b: 0});
		drag(tool, {x: 0.5, y: 1}, {x: 30.5, y: 1});
		tool.session.keyDown({key: 'Enter', modifiers: modifiers()});
		expect(tool.channels(0, 1)).toEqual([255, 255, 0, 255]);
		expect(tool.channels(20, 1)).toEqual([0, 0, 255, 255]);
		tool.session.dispose();
	});

	it('reports an empty selection and scales the ramp with opacity', () => {
		const tool = harness();
		updateGradientSettings({opacity: 0.5});
		drag(tool, {x: 0.5, y: 7}, {x: 4.5, y: 7});
		const preview = brushPreviewPixels('asset-1');
		expect(preview?.data[(7 * 40 + 0) * 4]).toBe(128);
		tool.session.pointerCancel('escape');
		tool.context.document.selections[ACTIVE_SELECTION_ID] = {
			id: ACTIVE_SELECTION_ID,
			bounds: {x: 0, y: 0, width: 0, height: 0},
			feather: 0,
			geometry: {antialiased: false, shape: {kind: 'empty'}},
		};
		tool.session.pointerDown(tool.pointer(30, 18));
		expect(getGradientSettings().error).toContain('选区是空的');
		tool.session.dispose();
	});

	it('starts from foreground to transparent and keeps the layer under the clear stop', () => {
		const tool = harness([0, 0, 255, 255]);
		expect(getGradientSettings().style).toBe('foreground-to-transparent');
		drag(tool, {x: 0.5, y: 1}, {x: 8.5, y: 1});
		expect(tool.session.getOverlayState()?.gradient?.from.a).toBe(255);
		expect(tool.session.getOverlayState()?.gradient?.to.a).toBe(0);
		tool.session.keyDown({key: 'Enter', modifiers: modifiers()});
		expect(tool.channels(0, 1)).toEqual([0, 0, 0, 255]);
		expect(tool.channels(8, 1)).toEqual([0, 0, 255, 255]);
		tool.session.dispose();
	});

	it('replaces a pending line, and a click with no length throws it away', () => {
		const tool = harness([255, 0, 0, 255]);
		setGradientStyle('foreground-to-background');
		drag(tool, {x: 0.5, y: 4}, {x: 6.5, y: 4});
		expect(getGradientPending()).toBe(true);
		// Away from both stops, so this starts a new line instead of dragging an end.
		drag(tool, {x: 30.5, y: 4}, {x: 10.5, y: 4});
		expect(tool.history.canUndo).toBe(false);
		tool.session.keyDown({key: 'Enter', modifiers: modifiers()});
		expect(tool.channels(30, 4)).toEqual([0, 0, 0, 255]);
		expect(tool.channels(10, 4)).toEqual([255, 255, 255, 255]);
		expect(tool.channels(0, 4)).toEqual([255, 255, 255, 255]);
		tool.context.document = tool.history.undo(tool.context.document);
		drag(tool, {x: 0.5, y: 4}, {x: 12.5, y: 4});
		tool.session.pointerDown(tool.pointer(30, 16));
		tool.session.pointerUp(tool.pointer(30, 16));
		expect(getGradientPending()).toBe(false);
		expect(brushPreviewPixels('asset-1')).toBeUndefined();
		expect(tool.history.canUndo).toBe(false);
		expect(tool.channels(0, 4)).toEqual([255, 0, 0, 255]);
		tool.session.dispose();
	});

	it('grabs the end when both stops are within 10 view points, and zoom shrinks that reach', () => {
		const tool = harness();
		drag(tool, {x: 10, y: 10}, {x: 14, y: 10});
		tool.session.pointerDown(tool.pointer(10, 10));
		tool.session.pointerMove(tool.pointer(10, 18));
		tool.session.pointerUp(tool.pointer(10, 18));
		expect(tool.session.getOverlayState()?.gradient).toMatchObject({start: {x: 10, y: 10}, end: {x: 10, y: 18}});
		tool.session.pointerCancel('escape');
		drag(tool, {x: 2, y: 6}, {x: 16, y: 6});
		tool.context.viewport.transform.zoom = 2;
		tool.session.pointerDown(tool.pointer(22, 6));
		tool.session.pointerUp(tool.pointer(22, 6));
		expect(tool.session.getOverlayState()?.gradient ?? null).toBeNull();
		tool.session.dispose();
	});

	it('applies on tool change and when the active layer changes, and Undo only discards the line', async () => {
		const tool = harness([255, 0, 0, 255]);
		setGradientStyle('foreground-to-background');
		const before = tool.assetId();
		drag(tool, {x: 0.5, y: 3}, {x: 8.5, y: 3});
		expect(dismissPendingGradient()).toBe(true);
		expect(tool.history.canUndo).toBe(false);
		expect(tool.assetId()).toBe(before);
		expect(brushPreviewPixels('asset-1')).toBeUndefined();
		expect(dismissPendingGradient()).toBe(false);
		drag(tool, {x: 0.5, y: 3}, {x: 8.5, y: 3});
		tool.session.pointerCancel('tool-switch');
		expect(tool.history.canUndo).toBe(true);
		expect(tool.assetId()).not.toBe(before);
		expect(getGradientPending()).toBe(false);
		tool.context.document = tool.history.undo(tool.context.document);
		drag(tool, {x: 0.5, y: 3}, {x: 8.5, y: 3});
		tool.session.updateContext({...tool.context, activeLayerId: 'other', selectedLayerIds: ['other']});
		expect(tool.assetId()).toBe('asset-1');
		await Promise.resolve();
		expect(tool.assetId()).not.toBe('asset-1');
		expect(getGradientPending()).toBe(false);
		tool.session.dispose();
	});

	it('samples a color with Option and leaves the pending line where it is', () => {
		const tool = harness([20, 40, 60, 255]);
		drag(tool, {x: 1, y: 2}, {x: 14, y: 2});
		const end = tool.session.getOverlayState()?.gradient?.end;
		tool.session.pointerDown(tool.pointer(3, 3, {alt: true}));
		tool.session.pointerUp(tool.pointer(3, 3, {alt: true}));
		expect(getBrushToolSettings().foreground).toEqual({r: 20, g: 40, b: 60});
		expect(tool.session.getOverlayState()?.gradient?.end).toEqual(end);
		expect(tool.history.canUndo).toBe(false);
		expect(getGradientPending()).toBe(true);
		tool.session.pointerCancel('escape');
		tool.session.dispose();
	});

	it('refreshes the pending ramp when the stops are reversed', () => {
		const tool = harness();
		setGradientStyle('foreground-to-background');
		drag(tool, {x: 0.5, y: 5}, {x: 10.5, y: 5});
		setGradientReverse(true);
		expect(tool.session.getOverlayState()?.gradient?.from).toMatchObject({r: 255, a: 255});
		expect(tool.session.getOverlayState()?.gradient?.to).toMatchObject({r: 0, a: 255});
		const preview = brushPreviewPixels('asset-1');
		expect(preview?.data[(5 * 40 + 0) * 4]).toBe(255);
		tool.session.pointerCancel('escape');
		tool.session.dispose();
	});
});
