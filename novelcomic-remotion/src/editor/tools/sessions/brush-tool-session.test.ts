import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand, type DocumentCommand, type DocumentCommandPayloads, type DocumentCommandType} from '../../commands/document-command-types';
import {createEmptyDocument, createPixelLayer} from '../../document/defaults';
import {ACTIVE_SELECTION_ID} from '../../document/selection-geometry';
import type {AssetRecord} from '../../document/types';
import {createPixelBuffer} from '../../pixels/pixel-tools';
import {brushPreviewPixels, brushSourcePixels, rememberBrushPixels, resetBrushPixels} from '../brush/brush-pixels';
import {
	changeBrushHardness,
	changeBrushSize,
	getBrushToolSettings,
	resetBrushToolSettings,
	typeBrushOpacityDigit,
	updateBrushToolSettings,
} from '../brush/brush-settings';
import {documentToViewport} from '../coordinates';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {BrushToolSession} from './brush-tool-session';

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
	document: {width: 32, height: 32},
	transform: {zoom: 1, panX: 0, panY: 0, rotation: 0 as const, devicePixelRatio: 1},
	followsFit: false,
	pointsPerPixel: 1,
};

const raster = (id: string, width: number, height: number, objectKey = `memory://${id}`): AssetRecord => ({
	id,
	kind: 'raster',
	originalName: `${id}.png`,
	mimeType: 'image/png',
	width,
	height,
	byteSize: width * height * 4,
	objectKey,
	contentHash: id,
});

const harness = () => {
	const history = new DocumentCommandHistory();
	const document = createEmptyDocument({width: 32, height: 32, projectId: 'p'});
	const layer = createPixelLayer('asset-1', 'Paint', 32, 32);
	layer.id = 'layer-1';
	document.layers[layer.id] = layer;
	document.rootLayerIds = [layer.id];
	document.assets['asset-1'] = raster('asset-1', 32, 32);
	rememberBrushPixels('asset-1', createPixelBuffer(32, 32));
	const context = {
		document,
		selectedLayerIds: [layer.id],
		activeLayerId: layer.id,
		viewport: structuredClone(viewport),
		setSelection: () => undefined,
		clearSelection: () => undefined,
		commitSelection: () => undefined,
		dispatch: (type: DocumentCommandType, payload: DocumentCommandPayloads[DocumentCommandType]) => {
			context.document = history.execute(
				context.document,
				createDocumentCommand({type, payload, projectId: context.document.projectId}),
			);
		},
		dispatchCommands: (commands: readonly DocumentCommand[]) => {
			context.document = history.executeTransaction(context.document, commands);
		},
		setViewportPan: () => undefined,
		setViewportZoom: () => undefined,
	} as ToolSessionContext;
	const session = new BrushToolSession(context);
	const pointer = (x: number, y: number, keys: Partial<ToolModifiers> = {}, buttons = 1): ToolPointerEvent => {
		const documentPoint = {x, y};
		return {
			pointerId: 1,
			pointerType: 'mouse',
			buttons,
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
		alpha(x: number, y: number) {
			const pixels = brushSourcePixels(this.assetId());
			return pixels?.data[(y * pixels.width + x) * 4 + 3] ?? -1;
		},
	};
};

describe('brush tool session', () => {
	beforeEach(() => {
		resetBrushToolSettings();
		resetBrushPixels();
	});

	it('paints the foreground color and undoes the whole gesture at once', () => {
		const tool = harness();
		updateBrushToolSettings({diameter: 8, foreground: {r: 255, g: 0, b: 0}});
		const before = tool.assetId();
		tool.session.pointerDown(tool.pointer(16, 16));
		tool.session.pointerMove(tool.pointer(20, 16));
		tool.session.pointerUp(tool.pointer(20, 16));
		expect(tool.assetId()).not.toBe(before);
		const pixels = brushSourcePixels(tool.assetId());
		const offset = (16 * 32 + 16) * 4;
		expect(pixels?.data[offset]).toBe(255);
		expect(pixels?.data[offset + 3]).toBe(255);
		expect(tool.alpha(0, 0)).toBe(0);
		expect(tool.context.document.layers[tool.layer.id]?.transform.width).toBe(32);
		tool.context.document = tool.history.undo(tool.context.document);
		expect(tool.assetId()).toBe(before);
		expect(tool.history.canRedo).toBe(true);
	});

	it('drops a cancelled stroke and explains why a press cannot paint', () => {
		const tool = harness();
		updateBrushToolSettings({diameter: 8});
		tool.session.pointerDown(tool.pointer(8, 8));
		tool.session.pointerMove(tool.pointer(16, 8));
		expect(brushPreviewPixels('asset-1')?.data[(8 * 32 + 12) * 4 + 3]).toBeGreaterThan(0);
		tool.session.pointerCancel('escape');
		expect(brushPreviewPixels('asset-1')).toBeUndefined();
		expect(tool.assetId()).toBe('asset-1');
		tool.context.selectedLayerIds = ['layer-1', 'other'];
		tool.session.pointerDown(tool.pointer(8, 8));
		expect(getBrushToolSettings().error).toContain('多个图层');
		expect(tool.assetId()).toBe('asset-1');
	});

	it('keeps a shifted drag on one axis and clicks a line on from the previous stroke', () => {
		const tool = harness();
		updateBrushToolSettings({diameter: 4});
		tool.session.pointerDown(tool.pointer(8, 8));
		tool.session.pointerMove(tool.pointer(20, 12, {shift: true}));
		tool.session.pointerUp(tool.pointer(20, 12, {shift: true}));
		expect(tool.alpha(20, 8)).toBeGreaterThan(0);
		expect(tool.alpha(20, 16)).toBe(0);
		const first = tool.assetId();
		tool.session.pointerDown(tool.pointer(24, 18, {shift: true}));
		tool.session.pointerUp(tool.pointer(24, 18, {shift: true}));
		expect(tool.assetId()).not.toBe(first);
		expect(tool.alpha(22, 13)).toBeGreaterThan(0);
	});

	it('trails a smoothed stroke and catches up when the button is released', () => {
		const tool = harness();
		updateBrushToolSettings({diameter: 4, smoothing: 100});
		tool.session.pointerDown(tool.pointer(4, 16));
		tool.session.pointerMove(tool.pointer(14, 16));
		const preview = brushPreviewPixels('asset-1');
		expect(preview?.data[(16 * 32 + 4) * 4 + 3]).toBeGreaterThan(0);
		expect(preview?.data[(16 * 32 + 14) * 4 + 3] ?? 0).toBe(0);
		tool.session.pointerUp(tool.pointer(14, 16));
		expect(tool.alpha(14, 16)).toBeGreaterThan(0);
	});

	it('sizes the tip from a right-drag and steps size, hardness and opacity from the keyboard', () => {
		const tool = harness();
		const down = tool.pointer(10, 10, {}, 2);
		down.viewportPoint = {x: 100, y: 80};
		tool.session.pointerDown(down);
		const drag = tool.pointer(18, 10, {}, 2);
		drag.viewportPoint = {x: 110, y: 80};
		tool.session.pointerMove(drag);
		expect(getBrushToolSettings().diameter).toBe(60);
		expect(tool.session.getOverlayState()?.brushCursor).toMatchObject({x: 10, y: 10, diameter: 60});
		tool.session.pointerUp(drag);
		expect(tool.assetId()).toBe('asset-1');
		updateBrushToolSettings({hardness: 0.5});
		const hardnessDown = tool.pointer(10, 10, {shift: true}, 2);
		hardnessDown.viewportPoint = {x: 100, y: 80};
		tool.session.pointerDown(hardnessDown);
		const hardnessDrag = tool.pointer(10, 10, {shift: true}, 2);
		hardnessDrag.viewportPoint = {x: 0, y: 80};
		tool.session.pointerMove(hardnessDrag);
		expect(getBrushToolSettings().hardness).toBe(0);
		expect(getBrushToolSettings().diameter).toBe(60);
		expect(tool.session.getOverlayState()?.brushCursor?.hardness).toBe(0);
		tool.session.pointerUp(hardnessDrag);
		expect(changeBrushSize(true)).toBe(true);
		expect(getBrushToolSettings().diameter).toBe(72);
		expect(changeBrushHardness(true)).toBe(true);
		expect(getBrushToolSettings().hardness).toBe(0.25);
		expect(typeBrushOpacityDigit(4, 1_000)).toBe(true);
		expect(typeBrushOpacityDigit(5, 1_200)).toBe(true);
		expect(getBrushToolSettings().opacity).toBe(0.45);
		expect(tool.session.keyDown({key: ']', modifiers: modifiers()})).toBe(true);
		expect(getBrushToolSettings().diameter).toBe(86);
	});

	it('grows a layer so a stroke can land outside its old pixels', () => {
		const tool = harness();
		tool.layer.transform = {...tool.layer.transform, width: 8, height: 8};
		tool.context.document.assets['asset-1'] = raster('asset-1', 8, 8);
		rememberBrushPixels('asset-1', createPixelBuffer(8, 8));
		const previews: Array<number | null> = [];
		tool.context.setMovePreview = (next) => {
			previews.push(next?.layers[tool.layer.id]?.transform.width ?? null);
		};
		updateBrushToolSettings({diameter: 4});
		tool.session.pointerDown(tool.pointer(12, 4));
		tool.session.pointerUp(tool.pointer(12, 4));
		expect(previews).toEqual([32, null]);
		const layer = tool.context.document.layers[tool.layer.id]!;
		expect(layer.transform.width).toBe(32);
		expect(layer.transform.originX).toBe(0);
		expect(tool.alpha(12, 4)).toBeGreaterThan(0);
		expect(tool.alpha(2, 2)).toBe(0);
		tool.context.document = tool.history.undo(tool.context.document);
		expect(tool.context.document.layers[tool.layer.id]?.transform.width).toBe(8);
	});

	it('samples a layer pixel with Option and refuses an empty selection', () => {
		const tool = harness();
		const seeded = createPixelBuffer(32, 32);
		seeded.data[(4 * 32 + 4) * 4] = 20;
		seeded.data[(4 * 32 + 4) * 4 + 1] = 40;
		seeded.data[(4 * 32 + 4) * 4 + 2] = 60;
		seeded.data[(4 * 32 + 4) * 4 + 3] = 255;
		rememberBrushPixels('asset-1', seeded);
		tool.session.pointerDown(tool.pointer(4.2, 4.2, {alt: true}));
		tool.session.pointerUp(tool.pointer(4.2, 4.2, {alt: true}));
		expect(getBrushToolSettings().foreground).toEqual({r: 20, g: 40, b: 60});
		expect(tool.assetId()).toBe('asset-1');
		tool.context.document.selections[ACTIVE_SELECTION_ID] = {
			id: ACTIVE_SELECTION_ID,
			bounds: {x: 0, y: 0, width: 0, height: 0},
			feather: 0,
			geometry: {antialiased: false, shape: {kind: 'empty'}},
		};
		tool.session.pointerDown(tool.pointer(8, 8));
		expect(getBrushToolSettings().error).toContain('选区是空的');
	});

	it('clips paint to the selection and waits while the image is still loading', () => {
		const tool = harness();
		updateBrushToolSettings({diameter: 2});
		tool.context.document.selections[ACTIVE_SELECTION_ID] = {
			id: ACTIVE_SELECTION_ID,
			bounds: {x: 0, y: 0, width: 6, height: 6},
			feather: 0,
			geometry: {antialiased: false, shape: {kind: 'rect', bounds: {x: 0, y: 0, width: 6, height: 6}}},
		};
		tool.session.pointerDown(tool.pointer(2, 2));
		tool.session.pointerUp(tool.pointer(2, 2));
		expect(tool.alpha(2, 2)).toBeGreaterThan(0);
		const painted = tool.assetId();
		tool.session.pointerDown(tool.pointer(20, 20));
		tool.session.pointerUp(tool.pointer(20, 20));
		expect(tool.assetId()).toBe(painted);
		const waiting = harness();
		waiting.context.document.assets['asset-1'] = raster('asset-1', 32, 32, 'https://example.com/paint.png');
		resetBrushPixels();
		waiting.session.pointerDown(waiting.pointer(8, 8));
		expect(getBrushToolSettings().error).toContain('还在加载');
	});
});
