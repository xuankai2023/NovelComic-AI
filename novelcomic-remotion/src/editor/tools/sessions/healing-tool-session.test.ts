import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand, type DocumentCommand, type DocumentCommandPayloads, type DocumentCommandType} from '../../commands/document-command-types';
import {createEmptyDocument, createPixelLayer} from '../../document/defaults';
import {ACTIVE_SELECTION_ID} from '../../document/selection-geometry';
import type {AssetRecord} from '../../document/types';
import {createPixelBuffer} from '../../pixels/pixel-tools';
import {brushPreviewPixels, brushSourcePixels, rememberBrushPixels, resetBrushPixels} from '../brush/brush-pixels';
import {getBrushToolSettings, resetBrushToolSettings, setHealingMode, updateBrushToolSettings, type SpotHealingMode} from '../brush/brush-settings';
import {documentToViewport} from '../coordinates';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {HealingToolSession} from './healing-tool-session';

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

const blemished = () => {
	const buffer = createPixelBuffer(120, 80);
	for (let y = 0; y < 80; y += 1) {
		for (let x = 0; x < 120; x += 1) {
			const red = x >= 55 && x < 65 && y >= 35 && y < 45;
			const gray = x % 4 < 2 ? 100 : 112;
			const offset = (y * 120 + x) * 4;
			buffer.data[offset] = red ? 230 : gray;
			buffer.data[offset + 1] = red ? 20 : gray;
			buffer.data[offset + 2] = red ? 20 : gray;
			buffer.data[offset + 3] = 255;
		}
	}
	return buffer;
};

const harness = () => {
	const history = new DocumentCommandHistory();
	const document = createEmptyDocument({width: 120, height: 80, projectId: 'p'});
	const layer = createPixelLayer('asset-1', 'Surface', 120, 80);
	layer.id = 'layer-1';
	document.layers[layer.id] = layer;
	document.rootLayerIds = [layer.id];
	document.assets['asset-1'] = raster('asset-1', 120, 80);
	rememberBrushPixels('asset-1', blemished());
	const viewport = {
		viewport: {width: 800, height: 600},
		document: {width: 120, height: 80},
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
	const session = new HealingToolSession(context);
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
		channels(x: number, y: number) {
			const pixels = brushSourcePixels(this.assetId());
			if (!pixels) return [];
			const offset = (y * pixels.width + x) * 4;
			return [pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2], pixels.data[offset + 3]];
		},
	};
};

describe('healing tool session', () => {
	beforeEach(() => {
		resetBrushToolSettings();
		resetBrushPixels();
	});

	it.each(['content-aware', 'create-texture', 'proximity-match'] as const)(
		'repairs the blemish in one undo and leaves the rest of the layer (%s)',
		(mode: SpotHealingMode) => {
			const tool = harness();
			setHealingMode(mode);
			updateBrushToolSettings({diameter: 24, hardness: 1, opacity: 1});
			const before = tool.assetId();
			tool.session.pointerDown(tool.pointer(60, 40));
			tool.session.pointerMove(tool.pointer(60.5, 40));
			const preview = brushPreviewPixels('asset-1');
			const wash = (40 * 120 + 60) * 4;
			expect((preview?.data[wash] ?? 0) - (preview?.data[wash + 1] ?? 0)).toBeGreaterThan(30);
			tool.session.pointerUp(tool.pointer(60.5, 40));
			expect(getBrushToolSettings().error).toBeNull();
			expect(tool.assetId()).not.toBe(before);
			expect(tool.history.canUndo).toBe(true);
			for (const [x, y] of [
				[60, 40],
				[56, 36],
				[64, 44],
			] as const) {
				const healed = tool.channels(x, y);
				expect(healed[0]! - healed[1]!, `${mode} (${x}, ${y}) ${healed.join(',')}`).toBeLessThan(30);
				expect(healed[1]).toBeGreaterThanOrEqual(80);
				expect(healed[1]).toBeLessThanOrEqual(130);
				expect(healed[3]).toBe(255);
			}
			expect(tool.channels(10, 10)).toEqual([112, 112, 112, 255]);
			expect(tool.channels(90, 40)).toEqual([112, 112, 112, 255]);
			tool.context.document = tool.history.undo(tool.context.document);
			expect(tool.assetId()).toBe(before);
		},
	);

	it('steps the healing type with Tab and resizes the shared tip', () => {
		const tool = harness();
		expect(getBrushToolSettings().healingMode).toBe('content-aware');
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getBrushToolSettings().healingMode).toBe('create-texture');
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getBrushToolSettings().healingMode).toBe('proximity-match');
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getBrushToolSettings().healingMode).toBe('content-aware');
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
		tool.session.pointerDown(tool.pointer(60, 40));
		expect(getBrushToolSettings().error).toContain('选区是空的');
	});
});
