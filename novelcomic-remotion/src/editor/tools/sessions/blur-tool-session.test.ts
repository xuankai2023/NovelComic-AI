import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import {createDocumentCommand, type DocumentCommand, type DocumentCommandPayloads, type DocumentCommandType} from '../../commands/document-command-types';
import {createEmptyDocument, createPixelLayer} from '../../document/defaults';
import type {AssetRecord} from '../../document/types';
import {createPixelBuffer, type PixelBuffer} from '../../pixels/pixel-tools';
import {blurSigma} from '../brush/blur-tool';
import {brushSourcePixels, rememberBrushPixels, resetBrushPixels} from '../brush/brush-pixels';
import {
	activateBrushTip,
	getBrushToolSettings,
	resetBrushToolSettings,
	setBlurMode,
	updateBrushToolSettings,
} from '../brush/brush-settings';
import {documentToViewport} from '../coordinates';
import {getToolDefinition} from '../tool-registry';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {BlurToolSession} from './blur-tool-session';

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

/** Opaque black on the left of `split`, opaque white on the right. */
const edge = (width = 200, height = 100, split = 100): PixelBuffer => {
	const buffer = createPixelBuffer(width, height, [0, 0, 0, 255]);
	for (let y = 0; y < height; y += 1) {
		for (let x = split; x < width; x += 1) {
			const offset = (y * width + x) * 4;
			buffer.data[offset] = 255;
			buffer.data[offset + 1] = 255;
			buffer.data[offset + 2] = 255;
		}
	}
	return buffer;
};

const harness = (pixels: PixelBuffer) => {
	const history = new DocumentCommandHistory();
	const document = createEmptyDocument({width: pixels.width, height: pixels.height, projectId: 'p'});
	const layer = createPixelLayer('asset-1', 'Edge', pixels.width, pixels.height);
	layer.id = 'layer-1';
	document.layers[layer.id] = layer;
	document.rootLayerIds = [layer.id];
	document.assets['asset-1'] = raster('asset-1', pixels.width, pixels.height);
	rememberBrushPixels('asset-1', pixels);
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
	const session = new BlurToolSession(context);
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
		assetId() {
			const content = context.document.layers[layer.id]?.content;
			return content?.kind === 'pixel' ? content.assetId : '';
		},
		channel(x: number, y: number) {
			const stored = brushSourcePixels(this.assetId());
			if (!stored) return -1;
			return stored.data[(y * stored.width + x) * 4] ?? -1;
		},
	};
};

const stroke = (tool: ReturnType<typeof harness>, from: {x: number; y: number}, to: {x: number; y: number}) => {
	tool.session.pointerDown(tool.pointer(from.x, from.y));
	tool.session.pointerMove(tool.pointer(to.x, to.y));
	tool.session.pointerUp(tool.pointer(to.x, to.y));
};

/** Columns on row 50 that are no longer black or white. */
const spread = (radius: number, diameter = 60) => {
	const tool = harness(edge());
	setBlurMode('blur');
	updateBrushToolSettings({diameter, hardness: 1, opacity: 1, blurRadius: radius});
	stroke(tool, {x: 100, y: 20}, {x: 100, y: 80});
	let count = 0;
	for (let x = 0; x < 200; x += 1) {
		const value = tool.channel(x, 50);
		if (value > 10 && value < 245) count += 1;
	}
	return count;
};

describe('blur tool', () => {
	beforeEach(() => {
		resetBrushToolSettings();
		resetBrushPixels();
	});

	it('keeps a soft tip of its own and steps Liquify, Blur, Smudge', () => {
		expect(getToolDefinition('blur').shortcut).toBe('R');
		expect(getToolDefinition('blur').statusHint).toContain('拖动推动像素');
		updateBrushToolSettings({diameter: 30, hardness: 1});
		activateBrushTip('blur');
		expect(getBrushToolSettings().hardness).toBe(0);
		expect(getBrushToolSettings().diameter).toBe(40);
		expect(getBrushToolSettings().blurMode).toBe('liquify');
		const tool = harness(edge(32, 32, 16));
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getBrushToolSettings().blurMode).toBe('blur');
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getBrushToolSettings().blurMode).toBe('smudge');
		expect(tool.session.keyDown({key: 'Tab', modifiers: modifiers()})).toBe(true);
		expect(getBrushToolSettings().blurMode).toBe('liquify');
		expect(blurSigma(100, 1, 200)).toBe(50);
		expect(blurSigma(12, 2, 400)).toBe(6);
		expect(blurSigma(12, 1, 10)).toBe(5);
	});

	it('softens by radius, not by brush size, and leaves the rest of the layer', () => {
		const narrow = spread(2);
		const wide = spread(12);
		expect(wide).toBeGreaterThan(narrow * 2);
		expect(spread(12, 80)).toBe(wide);
		const tool = harness(edge());
		setBlurMode('blur');
		updateBrushToolSettings({diameter: 60, hardness: 1, opacity: 1, blurRadius: 12});
		const before = tool.assetId();
		stroke(tool, {x: 100, y: 20}, {x: 100, y: 80});
		expect(getBrushToolSettings().error).toBeNull();
		expect(tool.history.canUndo).toBe(true);
		expect(tool.assetId()).not.toBe(before);
		expect(tool.channel(0, 0)).toBe(0);
		expect(tool.channel(199, 0)).toBe(255);
		tool.context.document = tool.history.undo(tool.context.document);
		expect(tool.assetId()).toBe(before);
		expect(tool.channel(100, 50)).toBe(255);
	});

	it('softens further on a second stroke', () => {
		const tool = harness(edge());
		setBlurMode('blur');
		updateBrushToolSettings({diameter: 60, hardness: 1, opacity: 1, blurRadius: 4});
		stroke(tool, {x: 100, y: 20}, {x: 100, y: 80});
		const once = tool.channel(96, 50);
		stroke(tool, {x: 100, y: 20}, {x: 100, y: 80});
		expect(tool.history.canUndo).toBe(true);
		const twice = tool.channel(96, 50);
		expect(twice).toBeGreaterThan(once);
		expect(twice).toBeLessThan(245);
	});

	it('pushes pixels with Liquify and drags color with Smudge', () => {
		const liquify = harness(edge(80, 40, 40));
		updateBrushToolSettings({diameter: 30, hardness: 1, opacity: 1});
		expect(getBrushToolSettings().blurMode).toBe('liquify');
		stroke(liquify, {x: 30, y: 20}, {x: 55, y: 20});
		expect(liquify.channel(48, 20)).toBeLessThan(200);
		expect(liquify.channel(0, 0)).toBe(0);
		expect(liquify.history.canUndo).toBe(true);

		const pixels = createPixelBuffer(80, 40, [0, 0, 0, 255]);
		for (let y = 10; y < 30; y += 1) {
			for (let x = 8; x < 18; x += 1) {
				const offset = (y * 80 + x) * 4;
				pixels.data[offset] = 255;
				pixels.data[offset + 3] = 255;
			}
		}
		const smudge = harness(pixels);
		setBlurMode('smudge');
		updateBrushToolSettings({diameter: 16, hardness: 1, opacity: 1});
		stroke(smudge, {x: 12, y: 20}, {x: 40, y: 20});
		// Strength 1 drags the color with the brush instead of leaving a trail.
		expect(smudge.channel(40, 20)).toBe(255);
		expect(smudge.channel(12, 20)).toBe(0);
		expect(smudge.channel(70, 20)).toBe(0);
	});

	it('cancels a liquify drag without writing history', () => {
		const tool = harness(edge(80, 40, 40));
		updateBrushToolSettings({diameter: 30, hardness: 1, opacity: 1});
		const before = tool.assetId();
		tool.session.pointerDown(tool.pointer(30, 20));
		tool.session.pointerMove(tool.pointer(55, 20));
		tool.session.pointerCancel('escape');
		expect(tool.assetId()).toBe(before);
		expect(tool.history.canUndo).toBe(false);
		expect(tool.channel(48, 20)).toBe(255);
	});
});
