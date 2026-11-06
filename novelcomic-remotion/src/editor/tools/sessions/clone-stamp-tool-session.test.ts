import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand, type DocumentCommand, type DocumentCommandPayloads, type DocumentCommandType} from '../../commands/document-command-types';
import {createEmptyDocument, createPixelLayer} from '../../document/defaults';
import {ACTIVE_SELECTION_ID} from '../../document/selection-geometry';
import type {AssetRecord, DocumentState} from '../../document/types';
import {createPixelBuffer, type PixelBuffer} from '../../pixels/pixel-tools';
import {activateBrushTip} from '../brush/brush-settings';
import {brushSourcePixels, rememberBrushPixels, resetBrushPixels} from '../brush/brush-pixels';
import {getBrushToolSettings, resetBrushToolSettings, updateBrushToolSettings} from '../brush/brush-settings';
import {getCloneSettings, resetCloneSettings, setCloneAligned, setCloneSampleAll} from '../brush/clone-stamp';
import {documentToViewport} from '../coordinates';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {CloneStampToolSession} from './clone-stamp-tool-session';

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

/** Left half red, right half blue, with a green square at x 10–19, y 15–24. */
const checker = (): PixelBuffer => {
	const buffer = createPixelBuffer(80, 40);
	for (let y = 0; y < 40; y += 1) {
		for (let x = 0; x < 80; x += 1) {
			const green = x >= 10 && x < 20 && y >= 15 && y < 25;
			const red = x < 40;
			const offset = (y * 80 + x) * 4;
			buffer.data[offset] = green ? 0 : red ? 255 : 0;
			buffer.data[offset + 1] = green ? 255 : 0;
			buffer.data[offset + 2] = green || red ? 0 : 255;
			buffer.data[offset + 3] = 255;
		}
	}
	return buffer;
};

const harness = (pixels: PixelBuffer = checker(), extra?: (document: DocumentState) => void) => {
	const history = new DocumentCommandHistory();
	const document = createEmptyDocument({width: pixels.width, height: pixels.height, projectId: 'p'});
	const layer = createPixelLayer('asset-1', 'Colors', pixels.width, pixels.height);
	layer.id = 'layer-1';
	document.layers[layer.id] = layer;
	document.rootLayerIds = [layer.id];
	document.assets['asset-1'] = raster('asset-1', pixels.width, pixels.height);
	rememberBrushPixels('asset-1', pixels);
	extra?.(document);
	const viewport = {
		viewport: {width: 800, height: 600},
		document: {width: pixels.width, height: pixels.height},
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
	const session = new CloneStampToolSession(context);
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
	const stroke = (x: number, y: number) => {
		session.pointerDown(pointer(x, y));
		session.pointerMove(pointer(x + 0.5, y));
		session.pointerUp(pointer(x + 0.5, y));
	};
	return {
		history,
		context,
		session,
		pointer,
		stroke,
		layer,
		assetId() {
			const content = context.document.layers[layer.id]?.content;
			return content?.kind === 'pixel' ? content.assetId : '';
		},
		channels(x: number, y: number, assetId?: string) {
			const stored = brushSourcePixels(assetId ?? this.assetId());
			if (!stored) return [];
			const offset = (y * stored.width + x) * 4;
			return [stored.data[offset], stored.data[offset + 1], stored.data[offset + 2], stored.data[offset + 3]];
		},
	};
};

describe('clone stamp tool session', () => {
	beforeEach(() => {
		resetBrushToolSettings();
		resetCloneSettings();
		resetBrushPixels();
		activateBrushTip('clone-stamp');
	});

	it('copies the source under the brush and keeps alignment until it is turned off', () => {
		const tool = harness();
		updateBrushToolSettings({diameter: 6, hardness: 1});
		const original = tool.assetId();
		tool.session.pointerDown(tool.pointer(60, 20));
		tool.session.pointerUp(tool.pointer(60, 20));
		expect(getBrushToolSettings().error).toContain('Option');
		expect(tool.assetId()).toBe(original);

		tool.session.pointerDown(tool.pointer(15, 20, {alt: true}));
		tool.session.pointerUp(tool.pointer(15, 20, {alt: true}));
		expect(getCloneSettings().source).toEqual({x: 15, y: 20});
		expect(getBrushToolSettings().error).toBeNull();
		expect(tool.assetId()).toBe(original);
		tool.session.keyUp({key: 'Alt', modifiers: modifiers()});
		const hover = tool.session.getOverlayState()?.brushCursor;
		expect(tool.session.getOverlayState()?.canvasCursor).toBe('none');
		expect(hover?.sample).toEqual({x: 15, y: 20});
		const preview = hover?.preview;
		expect(preview?.width).toBe(6);
		expect(preview && Array.from(preview.data.subarray((2 * preview.width + 2) * 4, (2 * preview.width + 2) * 4 + 4))).toEqual([0, 255, 0, 255]);

		tool.stroke(60, 20);
		expect(getBrushToolSettings().error).toBeNull();
		expect(tool.history.canUndo).toBe(true);
		expect(tool.channels(60, 20)).toEqual([0, 255, 0, 255]);
		expect(tool.channels(70, 5)).toEqual([0, 0, 255, 255]);

		tool.stroke(66, 20);
		expect(tool.channels(66, 20)).toEqual([255, 0, 0, 255]);
		expect(tool.channels(60, 20)).toEqual([0, 255, 0, 255]);
		tool.session.pointerMove(tool.pointer(66, 20, {}, 0));
		expect(tool.session.getOverlayState()?.brushCursor?.sample).toEqual({x: 21, y: 20});

		setCloneAligned(false);
		tool.stroke(50, 10);
		expect(tool.channels(50, 10)).toEqual([0, 255, 0, 255]);
		expect(tool.channels(66, 20)).toEqual([255, 0, 0, 255]);

		let restored = tool.context.document;
		restored = tool.history.undo(restored);
		restored = tool.history.undo(restored);
		restored = tool.history.undo(restored);
		tool.context.document = restored;
		expect(tool.history.canUndo).toBe(false);
		expect(tool.channels(60, 20)).toEqual([0, 0, 255, 255]);
		expect(tool.channels(15, 20)).toEqual([0, 255, 0, 255]);
	});

	it('samples every visible layer when asked, and only the active layer otherwise', () => {
		const base = createPixelBuffer(80, 40);
		for (let index = 0; index < base.data.length; index += 4) {
			const x = (index / 4) % 80;
			base.data[index] = x < 40 ? 255 : 0;
			base.data[index + 2] = x < 40 ? 0 : 255;
			base.data[index + 3] = 255;
		}
		const top = createPixelBuffer(80, 40);
		for (let y = 15; y < 25; y += 1) {
			for (let x = 10; x < 20; x += 1) {
				const offset = (y * 80 + x) * 4;
				top.data[offset + 1] = 255;
				top.data[offset + 3] = 255;
			}
		}
		const tool = harness(base, (document) => {
			const overlay = createPixelLayer('asset-2', 'Overlay', 80, 40);
			overlay.id = 'layer-2';
			overlay.order = 1;
			document.layers[overlay.id] = overlay;
			document.rootLayerIds = ['layer-1', overlay.id];
			document.assets['asset-2'] = raster('asset-2', 80, 40);
			rememberBrushPixels('asset-2', top);
		});
		updateBrushToolSettings({diameter: 6, hardness: 1});
		tool.session.pointerDown(tool.pointer(15, 20, {alt: true}));
		tool.session.pointerUp(tool.pointer(15, 20));

		setCloneSampleAll(false);
		tool.stroke(60, 20);
		expect(tool.channels(60, 20)).toEqual([255, 0, 0, 255]);

		setCloneAligned(false);
		setCloneSampleAll(true);
		tool.stroke(60, 30);
		expect(tool.channels(60, 30)).toEqual([0, 255, 0, 255]);
		expect(tool.channels(15, 20, 'asset-2')).toEqual([0, 255, 0, 255]);
	});

	it('resizes its own tip, switches sample with Tab, and refuses an empty selection', () => {
		const tool = harness();
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getCloneSettings().sampleAllLayers).toBe(true);
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getCloneSettings().sampleAllLayers).toBe(false);
		const down = tool.pointer(10, 10, {}, 2);
		down.viewportPoint = {x: 100, y: 80};
		tool.session.pointerDown(down);
		const drag = tool.pointer(18, 10, {}, 2);
		drag.viewportPoint = {x: 110, y: 80};
		tool.session.pointerMove(drag);
		expect(getBrushToolSettings().diameter).toBe(60);
		tool.session.pointerUp(drag);
		expect(tool.assetId()).toBe('asset-1');
		tool.context.document.selections[ACTIVE_SELECTION_ID] = {
			id: ACTIVE_SELECTION_ID,
			bounds: {x: 0, y: 0, width: 0, height: 0},
			feather: 0,
			geometry: {antialiased: false, shape: {kind: 'empty'}},
		};
		tool.session.pointerDown(tool.pointer(15, 20, {alt: true}));
		expect(getCloneSettings().source).toEqual({x: 15, y: 20});
		tool.session.pointerUp(tool.pointer(15, 20));
		tool.session.pointerDown(tool.pointer(60, 20));
		expect(getBrushToolSettings().error).toContain('选区是空的');
	});
});
