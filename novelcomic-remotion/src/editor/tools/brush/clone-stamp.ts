import {flattenLayerTree} from '../../document/tree';
import type {BlendMode, DocumentState, LayerNode} from '../../document/types';
import {createPixelBuffer, type PixelBuffer} from '../../pixels/pixel-tools';
import type {ToolPoint} from '../types';
import {brushSourcePixels} from './brush-pixels';
import {brushFalloff, makeBrushSpace, type BrushSpace} from './brush-stroke';

/**
 * Clone Stamp, matching Compositor's CloneStamp.swift.
 * Option-click stores a document-space source. A stroke copies from
 * `brush + offset`, where offset is source − brush, rounded to whole pixels.
 * Aligned strokes keep the first offset. Otherwise every stroke starts at the source.
 */
export type CloneColor = {r: number; g: number; b: number; a: number};

export type CloneSettings = {
	aligned: boolean;
	sampleAllLayers: boolean;
	source: ToolPoint | null;
	/** Document pixels from the brush to the source. Set when a stroke starts; cleared by a new source. */
	offset: ToolPoint | null;
};

export const CLONE_SOURCE_REQUIRED = '请先按住 Option 点击，设定仿制图章要复制的位置。';
export const CLONE_SAMPLE_EMPTY = '没有可以仿制的像素。';

const defaults = (): CloneSettings => ({
	aligned: true,
	sampleAllLayers: false,
	source: null,
	offset: null,
});

let settings = defaults();
const listeners = new Set<() => void>();

const samePoint = (left: ToolPoint | null, right: ToolPoint | null) =>
	left === right || (left !== null && right !== null && left.x === right.x && left.y === right.y);

const same = (next: CloneSettings) =>
	next.aligned === settings.aligned &&
	next.sampleAllLayers === settings.sampleAllLayers &&
	samePoint(next.source, settings.source) &&
	samePoint(next.offset, settings.offset);

const emit = (next: CloneSettings) => {
	if (same(next)) return;
	settings = next;
	for (const listener of listeners) listener();
};

/** Half away from zero, matching Swift's `rounded()`. */
const roundDocument = (value: number) => Math.sign(value) * Math.round(Math.abs(value));

const finitePoint = (point: ToolPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

export const getCloneSettings = () => settings;

export const subscribeCloneSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const setCloneAligned = (aligned: boolean) => emit({...settings, aligned});

export const setCloneSampleAll = (sampleAllLayers: boolean) => emit({...settings, sampleAllLayers});

/** Tab steps Sample between the current layer and every visible layer. */
export const toggleCloneSample = () => emit({...settings, sampleAllLayers: !settings.sampleAllLayers});

/** Option-click. A new source starts a new alignment. */
export const setCloneSource = (point: ToolPoint) => {
	if (!finitePoint(point)) return;
	emit({...settings, source: {x: point.x, y: point.y}, offset: null});
};

export const setCloneOffset = (offset: ToolPoint) => {
	if (!finitePoint(offset)) return;
	emit({...settings, offset: {x: offset.x, y: offset.y}});
};

/**
 * The whole-pixel offset a stroke starting at `point` copies with.
 * Shared by the stroke and the hover preview, so the preview is what a click stamps.
 */
export const cloneStrokeOffset = (point: ToolPoint): ToolPoint | null => {
	if (!settings.source || !finitePoint(point)) return null;
	if (settings.aligned && settings.offset) return {x: settings.offset.x, y: settings.offset.y};
	return {
		x: roundDocument(settings.source.x - point.x),
		y: roundDocument(settings.source.y - point.y),
	};
};

/**
 * Where the source crosshair sits for a brush at `point`.
 * The source itself until a stroke fixes the offset; unaligned, it returns there between strokes.
 */
export const cloneSamplePoint = (point: ToolPoint, stroking: boolean): ToolPoint | null => {
	if (!settings.source) return null;
	if (!settings.offset || (!settings.aligned && !stroking)) return {x: settings.source.x, y: settings.source.y};
	return {x: point.x + settings.offset.x, y: point.y + settings.offset.y};
};

export const cloneStatusHint = () => 'Option 点击设定源点 · 拖动仿制 · [ ] 调整大小 · { } 硬度 · 数字键不透明度 · 空格平移';

export const resetCloneSettings = () => {
	settings = defaults();
	for (const listener of listeners) listener();
};

type StampLayer = {
	pixels: PixelBuffer;
	space: BrushSpace;
	opacity: number;
	blendMode: BlendMode;
};

const isShown = (document: DocumentState, layer: LayerNode) => {
	const seen = new Set<string>();
	let current: LayerNode | undefined = layer;
	while (current && !seen.has(current.id)) {
		if (!current.visible) return false;
		seen.add(current.id);
		current = current.parentId ? document.layers[current.parentId] : undefined;
	}
	return true;
};

const accumulatedOpacity = (document: DocumentState, layer: LayerNode) => {
	let opacity = layer.opacity;
	const seen = new Set<string>([layer.id]);
	let parentId = layer.parentId;
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = document.layers[parentId];
		if (!parent) break;
		opacity *= parent.opacity;
		parentId = parent.parentId;
	}
	return opacity;
};

/**
 * Continuous pixel index: 0 is the center of the first pixel.
 * `toPixel` is in edge space (0 is the left edge), so callers pass `toPixel - 0.5`.
 */
export const sampleBilinear = (pixels: PixelBuffer, x: number, y: number): CloneColor | null => {
	if (x < -0.5 || y < -0.5 || x > pixels.width - 0.5 || y > pixels.height - 0.5) return null;
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const tx = x - x0;
	const ty = y - y0;
	const at = (px: number, py: number): CloneColor => {
		if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) return {r: 0, g: 0, b: 0, a: 0};
		const index = (py * pixels.width + px) * 4;
		return {r: pixels.data[index] ?? 0, g: pixels.data[index + 1] ?? 0, b: pixels.data[index + 2] ?? 0, a: pixels.data[index + 3] ?? 0};
	};
	if (tx === 0 && ty === 0) return at(x0, y0);
	const mix = (left: CloneColor, right: CloneColor, t: number): CloneColor => ({
		r: left.r + (right.r - left.r) * t,
		g: left.g + (right.g - left.g) * t,
		b: left.b + (right.b - left.b) * t,
		a: left.a + (right.a - left.a) * t,
	});
	return mix(mix(at(x0, y0), at(x0 + 1, y0), tx), mix(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx), ty);
};

const blendChannel = (mode: BlendMode, backdrop: number, source: number) => {
	switch (mode) {
		case 'multiply':
			return backdrop * source;
		case 'screen':
			return 1 - (1 - backdrop) * (1 - source);
		case 'overlay':
			return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
		case 'darken':
			return Math.min(backdrop, source);
		case 'lighten':
			return Math.max(backdrop, source);
		case 'color-dodge':
			return source >= 1 ? 1 : Math.min(1, backdrop / (1 - source));
		case 'color-burn':
			return source <= 0 ? 0 : 1 - Math.min(1, (1 - backdrop) / source);
		case 'hard-light':
			return source <= 0.5 ? 2 * source * backdrop : 1 - 2 * (1 - source) * (1 - backdrop);
		case 'soft-light': {
			if (source <= 0.5) return backdrop - (1 - 2 * source) * backdrop * (1 - backdrop);
			const dodge = backdrop <= 0.25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(backdrop);
			return backdrop + (2 * source - 1) * (dodge - backdrop);
		}
		case 'difference':
			return Math.abs(backdrop - source);
		case 'exclusion':
			return backdrop + source - 2 * backdrop * source;
		default:
			return source;
	}
};

const sourceOver = (backdrop: CloneColor, source: CloneColor, opacity: number, mode: BlendMode): CloneColor => {
	if (mode === 'normal' && opacity >= 1 && source.a >= 255) return {r: source.r, g: source.g, b: source.b, a: 255};
	const as = Math.min(1, (source.a / 255) * opacity);
	if (as <= 0) return backdrop;
	const ab = backdrop.a / 255;
	const outA = as + ab * (1 - as);
	if (outA <= 0) return {r: 0, g: 0, b: 0, a: 0};
	const channel = (cb: number, cs: number) => {
		const blended = mode === 'normal' || ab <= 0 ? cs : blendChannel(mode, cb, cs);
		const mixed = (as * (1 - ab) * cs + as * ab * blended + (1 - as) * ab * cb) / outA;
		return Math.round(Math.min(1, Math.max(0, mixed)) * 255);
	};
	return {
		r: channel(backdrop.r / 255, source.r / 255),
		g: channel(backdrop.g / 255, source.g / 255),
		b: channel(backdrop.b / 255, source.b / 255),
		a: Math.round(outA * 255),
	};
};

const sampleLayer = (layer: StampLayer, x: number, y: number) => {
	const pixel = layer.space.toPixel({x, y});
	if (!pixel) return null;
	return sampleBilinear(layer.pixels, pixel.x - 0.5, pixel.y - 0.5);
};

const sampleStack = (layers: readonly StampLayer[], x: number, y: number): CloneColor | null => {
	let acc: CloneColor = {r: 0, g: 0, b: 0, a: 0};
	for (const layer of layers) {
		const sample = sampleLayer(layer, x, y);
		if (!sample || sample.a <= 0) continue;
		acc = sourceOver(acc, sample, layer.opacity, layer.blendMode);
	}
	return acc.a <= 0 ? null : acc;
};

/**
 * What a stroke copies. This Layer reads the active layer's own pixels.
 * All Layers reads the canvas as shown: visible pixel layers, bottom to top, with opacity and blend.
 * The active layer uses `pixels` (the stroke's snapshot), not whatever is committed afterwards.
 */
const collectStampLayers = (
	document: DocumentState,
	active: {id: string; pixels: PixelBuffer; space: BrushSpace},
	sampleAllLayers: boolean,
): StampLayer[] => {
	if (!sampleAllLayers) return [{pixels: active.pixels, space: active.space, opacity: 1, blendMode: 'normal'}];
	const shown = flattenLayerTree(document).filter((layer) => layer.kind === 'pixel' && layer.content.kind === 'pixel' && isShown(document, layer));
	const anySolo = shown.some((layer) => layer.solo);
	const layers: StampLayer[] = [];
	for (const layer of anySolo ? shown.filter((item) => item.solo) : shown) {
		if (layer.content.kind !== 'pixel') continue;
		const opacity = accumulatedOpacity(document, layer);
		if (opacity <= 0) continue;
		if (layer.id === active.id) {
			layers.push({pixels: active.pixels, space: active.space, opacity, blendMode: layer.blendMode});
			continue;
		}
		const pixels = brushSourcePixels(layer.content.assetId);
		if (!pixels) continue;
		const space = makeBrushSpace(document, layer, pixels.width, pixels.height);
		if (!space) continue;
		layers.push({pixels, space, opacity, blendMode: layer.blendMode});
	}
	return layers;
};

/** A destination document point copies the sample at that point plus the stroke offset. */
export const createCloneSampler = (input: {
	document: DocumentState;
	layer: LayerNode;
	pixels: PixelBuffer;
	space: BrushSpace;
	offset: ToolPoint;
}): ((x: number, y: number) => CloneColor | null) | null => {
	const layers = collectStampLayers(input.document, {id: input.layer.id, pixels: input.pixels, space: input.space}, settings.sampleAllLayers);
	if (!layers.length) return null;
	return (x, y) => sampleStack(layers, x + input.offset.x, y + input.offset.y);
};

/**
 * The patch inside the brush circle: `diameter` document pixels around `center`,
 * masked by the tip falloff. Capped so a 2000px brush does not rebuild a huge bitmap each move.
 */
export const renderClonePreview = (input: {
	document: DocumentState;
	activeLayerId: string | null;
	center: ToolPoint;
	diameter: number;
	hardness: number;
}): PixelBuffer | null => {
	const layer = input.activeLayerId ? input.document.layers[input.activeLayerId] : undefined;
	if (!layer || layer.kind !== 'pixel' || layer.content.kind !== 'pixel' || input.diameter <= 0) return null;
	const pixels = brushSourcePixels(layer.content.assetId);
	if (!pixels) return null;
	const space = makeBrushSpace(input.document, layer, pixels.width, pixels.height);
	if (!space) return null;
	const layers = collectStampLayers(input.document, {id: layer.id, pixels, space}, settings.sampleAllLayers);
	if (!layers.length) return null;
	const side = Math.min(160, Math.max(1, Math.round(input.diameter)));
	const buffer = createPixelBuffer(side, side);
	const radius = input.diameter / 2;
	for (let y = 0; y < side; y += 1) {
		for (let x = 0; x < side; x += 1) {
			const docX = input.center.x + ((x + 0.5) / side - 0.5) * input.diameter;
			const docY = input.center.y + ((y + 0.5) / side - 0.5) * input.diameter;
			const color = sampleStack(layers, docX, docY);
			const falloff = brushFalloff(Math.hypot(docX - input.center.x, docY - input.center.y), radius, input.hardness);
			if (!color || falloff <= 0) continue;
			const index = (y * side + x) * 4;
			buffer.data[index] = color.r;
			buffer.data[index + 1] = color.g;
			buffer.data[index + 2] = color.b;
			buffer.data[index + 3] = Math.round(color.a * falloff);
		}
	}
	return buffer;
};
