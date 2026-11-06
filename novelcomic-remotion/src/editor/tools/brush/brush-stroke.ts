import {DOCUMENT_LIMITS} from '../../document/limits';
import type {DocumentState, LayerNode, LayerTransform} from '../../document/types';
import {createPixelBuffer, type PixelBuffer} from '../../pixels/pixel-tools';
import {invertAffine, layerWorldMatrix, transformPoint, type ToolPoint} from '../coordinates';
import type {SpotHealingMode} from './brush-settings';
import {healCoverage, healingModeIndex} from '../../pixels/heal-pixels';

export type BrushStamp = {
	diameter: number;
	hardness: number;
	opacity: number;
	erasing: boolean;
	color: {r: number; g: number; b: number};
	/** Spot Healing paints a dark wash, then rebuilds the stroke from nearby texture. */
	healing?: boolean;
	healingMode?: SpotHealingMode;
};

/** The wash shown while a spot-healing stroke is down. Compositor uses sRGB 0.12 at 45% alpha. */
const HEALING_WASH = 0.12 * 255;

export type BrushSpace = {
	width: number;
	height: number;
	documentWidth: number;
	documentHeight: number;
	toPixel: (point: ToolPoint) => ToolPoint | null;
	toDocument: (point: ToolPoint) => ToolPoint | null;
};

type PixelRect = {x: number; y: number; width: number; height: number};

/** 0 at the rim, 1 inside the hardness radius. Matches BrushRaster.falloff. */
export const brushFalloff = (distance: number, radius: number, hardness: number) => {
	if (!(distance >= 0) || !(radius > 0) || distance > radius) return 0;
	if (hardness >= 1) return 1;
	const inner = radius * Math.max(0, hardness);
	if (distance <= inner) return 1;
	const span = radius - inner;
	if (span <= 0) return distance <= radius ? 1 : 0;
	const u = (distance - inner) / span;
	const k = 2.5;
	return Math.max(0, (Math.exp(-k * u * u) - Math.exp(-k)) / (1 - Math.exp(-k)));
};

/** Soft tips deposit a little closer together so the rim does not break into dots. */
export const brushSpacing = (diameter: number, hardness: number) =>
	Math.max(0.25, diameter * (hardness >= 1 ? 0.015 : 0.025));

export const identityBrushSpace = (width: number, height: number): BrushSpace => ({
	width,
	height,
	documentWidth: width,
	documentHeight: height,
	toPixel: (point) => ({x: point.x, y: point.y}),
	toDocument: (point) => ({x: point.x, y: point.y}),
});

const SNAP = 0.05;

/**
 * A brush can paint anywhere on the canvas, so the bitmap grows to cover it.
 * The returned transform keeps every old pixel where it was.
 */
export const prepareBrushSurface = (document: DocumentState, layer: LayerNode, source: PixelBuffer) => {
	const space = makeBrushSpace(document, layer, source.width, source.height);
	if (!space) return null;
	let minX = 0;
	let minY = 0;
	let maxX = source.width;
	let maxY = source.height;
	for (const corner of [
		{x: 0, y: 0},
		{x: document.width, y: 0},
		{x: 0, y: document.height},
		{x: document.width, y: document.height},
	]) {
		const pixel = space.toPixel(corner);
		if (!pixel) return null;
		minX = Math.min(minX, pixel.x);
		minY = Math.min(minY, pixel.y);
		maxX = Math.max(maxX, pixel.x);
		maxY = Math.max(maxY, pixel.y);
	}
	if (minX > -SNAP) minX = 0;
	if (minY > -SNAP) minY = 0;
	if (maxX < source.width + SNAP) maxX = source.width;
	if (maxY < source.height + SNAP) maxY = source.height;
	const x0 = Math.floor(minX);
	const y0 = Math.floor(minY);
	const x1 = Math.ceil(maxX);
	const y1 = Math.ceil(maxY);
	if (x0 === 0 && y0 === 0 && x1 === source.width && y1 === source.height) {
		return {pixels: source, space, transform: layer.transform};
	}
	const width = x1 - x0;
	const height = y1 - y0;
	const maxPixels = Math.floor(DOCUMENT_LIMITS.maxAssetBytes / 4);
	if (width < 1 || height < 1 || width > DOCUMENT_LIMITS.maxWidth || height > DOCUMENT_LIMITS.maxHeight || width * height > maxPixels) {
		throw new Error('图像太大，无法绘画。');
	}
	const pixels = createPixelBuffer(width, height);
	const destX = -x0;
	const destY = -y0;
	for (let y = 0; y < source.height; y += 1) {
		const from = y * source.width * 4;
		pixels.data.set(source.data.subarray(from, from + source.width * 4), ((y + destY) * width + destX) * 4);
	}
	const center = space.toDocument({x: x0 + width / 2, y: y0 + height / 2});
	if (!center || !source.width || !source.height) return null;
	const transform: LayerTransform = {
		...layer.transform,
		width: (width * layer.transform.width) / source.width,
		height: (height * layer.transform.height) / source.height,
		originX: center.x - Math.abs((width * layer.transform.width) / source.width * layer.transform.scaleX) / 2,
		originY: center.y - Math.abs((height * layer.transform.height) / source.height * layer.transform.scaleY) / 2,
	};
	const expandedDocument: DocumentState = {...document, layers: {...document.layers, [layer.id]: {...layer, transform}}};
	const expanded = makeBrushSpace(expandedDocument, expandedDocument.layers[layer.id]!, width, height);
	if (!expanded) return null;
	return {pixels, space: expanded, transform};
};

/** Document pixels to the layer's own pixel grid, including its rotation and scale. */
export const makeBrushSpace = (document: DocumentState, layer: LayerNode, width: number, height: number): BrushSpace | null => {
	if (width < 1 || height < 1 || !layer.transform.width || !layer.transform.height) return null;
	const matrix = layerWorldMatrix(document, layer.id);
	const inverse = matrix && invertAffine(matrix);
	if (!matrix || !inverse) return null;
	const scaleX = width / layer.transform.width;
	const scaleY = height / layer.transform.height;
	return {
		width,
		height,
		documentWidth: document.width,
		documentHeight: document.height,
		toPixel: (point) => {
			const local = transformPoint(inverse, point);
			return {x: local.x * scaleX, y: local.y * scaleY};
		},
		toDocument: (point) => transformPoint(matrix, {x: point.x / scaleX, y: point.y / scaleY}),
	};
};

/** Source-over of a clone sample. A clear sample leaves the layer pixel, so cloning does not erase. */
const blendClone = (
	base: {r: number; g: number; b: number; a: number},
	sample: {r: number; g: number; b: number; a: number},
	amount: number,
) => {
	if (amount >= 1 && sample.a >= 255) return {r: sample.r, g: sample.g, b: sample.b, a: 255};
	const as = (sample.a / 255) * amount;
	if (as <= 0) return base;
	const ab = base.a / 255;
	const outA = as + ab * (1 - as);
	if (outA <= 0) return {r: 0, g: 0, b: 0, a: 0};
	const channel = (baseByte: number, sampleByte: number) =>
		Math.round(((as * (sampleByte / 255) + ab * (baseByte / 255) * (1 - as)) / outA) * 255);
	return {
		r: channel(base.r, sample.r),
		g: channel(base.g, sample.g),
		b: channel(base.b, sample.b),
		a: Math.round(outA * 255),
	};
};

const union = (left: PixelRect, right: PixelRect): PixelRect => {
	const x = Math.min(left.x, right.x);
	const y = Math.min(left.y, right.y);
	return {x, y, width: Math.max(left.x + left.width, right.x + right.width) - x, height: Math.max(left.y + left.height, right.y + right.height) - y};
};

/**
 * One paint or erase gesture. Dabs follow a centripetal Catmull–Rom through the samples,
 * with a straight tail so the stroke never lags the pointer. Coverage is accumulated for
 * the whole stroke and then multiplied by opacity once, so overlaps cannot stack past it.
 */
export class BrushStroke {
	readonly diameter: number;
	private readonly source: PixelBuffer;
	private readonly output: PixelBuffer;
	private readonly coverage: Uint8ClampedArray;
	private readonly hard: boolean;
	private readonly spacing: number;
	private samples: ToolPoint[] = [];
	private previous: ToolPoint | null = null;
	private distanceToNext = 0;
	private dirty: PixelRect | null = null;
	private tailRect: PixelRect | null = null;
	private tailBackup: Uint8ClampedArray | null = null;
	private touched = false;
	/** Clone Stamp: color at a document point, already shifted by the source offset. Null leaves the pixel alone. */
	private cloneAt: ((documentX: number, documentY: number) => {r: number; g: number; b: number; a: number} | null) | null = null;

	constructor(
		source: PixelBuffer,
		private readonly settings: BrushStamp,
		private readonly space: BrushSpace,
		private readonly selection?: (documentX: number, documentY: number) => number,
	) {
		if (source.width !== space.width || source.height !== space.height) throw new Error('画笔像素和图层尺寸不一致。');
		if (source.width * source.height > 32_000_000) throw new Error('图像太大，无法绘画。');
		this.diameter = settings.diameter;
		this.source = source;
		this.output = {width: source.width, height: source.height, data: new Uint8ClampedArray(source.data)};
		this.coverage = new Uint8ClampedArray(source.width * source.height);
		this.hard = settings.hardness >= 1;
		this.spacing = brushSpacing(settings.diameter, settings.hardness);
	}

	get pixels() {
		return this.output;
	}

	get changed() {
		return this.touched;
	}

	/** Paint `sample` through the tip. The sample replaces covered pixels; transparent samples do not erase. */
	useClone(sample: (documentX: number, documentY: number) => {r: number; g: number; b: number; a: number} | null) {
		this.cloneAt = sample;
	}

	append(point: ToolPoint) {
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
		const last = this.samples[this.samples.length - 1];
		if (last && last.x === point.x && last.y === point.y) return;
		this.removeTail();
		this.samples.push({x: point.x, y: point.y});
		if (this.samples.length > 4) this.samples.shift();
		const count = this.samples.length;
		if (count === 1) this.walk(point);
		else if (count >= 3) {
			this.curve(this.samples[count - 3]!, this.samples[count - 2]!, this.samples[Math.max(0, count - 4)]!, this.samples[count - 1]!);
		}
		if (count >= 2) this.drawTail(this.samples[count - 2]!, point);
		this.reblend(this.dirty);
	}

	/**
	 * Spot Healing, once the stroke ends. Reads the layer's original pixels, never the
	 * dark wash, and writes the repaired area back. `seed` feeds Create Texture's grain.
	 */
	heal(seed = (Math.random() * 0x100000000) >>> 0) {
		if (!this.settings.healing || !this.touched) return;
		const width = this.output.width;
		const height = this.output.height;
		let x0 = width;
		let y0 = height;
		let x1 = 0;
		let y1 = 0;
		for (let y = 0; y < height; y += 1) {
			const row = y * width;
			for (let x = 0; x < width; x += 1) {
				if (!this.coverage[row + x]) continue;
				if (x < x0) x0 = x;
				if (x + 1 > x1) x1 = x + 1;
				if (y < y0) y0 = y;
				if (y + 1 > y1) y1 = y + 1;
			}
		}
		if (x1 <= x0 || y1 <= y0) return;
		// Room for the kernel's patch search, which looks up to about three spot-widths away.
		const reach = (Math.max(x1 - x0, y1 - y0) + 32) * 3.2;
		const rx0 = Math.max(0, Math.floor(x0 - reach));
		const ry0 = Math.max(0, Math.floor(y0 - reach));
		const rx1 = Math.min(width, Math.ceil(x1 + reach));
		const ry1 = Math.min(height, Math.ceil(y1 + reach));
		const regionWidth = rx1 - rx0;
		const regionHeight = ry1 - ry0;
		if (regionWidth < 1 || regionHeight < 1) return;
		const rgba = new Uint8Array(regionWidth * regionHeight * 4);
		const gray = new Uint8Array(regionWidth * regionHeight);
		for (let y = 0; y < regionHeight; y += 1) {
			const source = ((ry0 + y) * width + rx0) * 4;
			rgba.set(this.source.data.subarray(source, source + regionWidth * 4), y * regionWidth * 4);
			gray.set(this.coverage.subarray((ry0 + y) * width + rx0, (ry0 + y) * width + rx0 + regionWidth), y * regionWidth);
		}
		const status = healCoverage(
			rgba,
			gray,
			regionWidth,
			regionHeight,
			this.settings.opacity,
			healingModeIndex(this.settings.healingMode),
			seed >>> 0,
		);
		if (status !== 0) throw new Error('图像太大，无法修复。');
		for (let y = 0; y < regionHeight; y += 1) {
			const destination = ((ry0 + y) * width + rx0) * 4;
			this.output.data.set(rgba.subarray(y * regionWidth * 4, (y + 1) * regionWidth * 4), destination);
		}
	}

	/** Replaces the provisional tail with the stroke's final curve. Safe to repeat. */
	flush() {
		this.removeTail();
		const count = this.samples.length;
		if (count >= 2) {
			this.curve(this.samples[count - 2]!, this.samples[count - 1]!, this.samples[Math.max(0, count - 3)]!, this.samples[count - 1]!);
			this.samples = [this.samples[count - 1]!];
		}
		this.reblend(this.dirty);
	}

	private drawTail(from: ToolPoint, to: ToolPoint) {
		const rect = this.segmentBounds(from, to);
		if (!rect) return;
		this.tailRect = rect;
		this.tailBackup = this.copyCoverage(rect);
		const savedPrevious = this.previous;
		const savedDistance = this.distanceToNext;
		this.walk(to);
		this.previous = savedPrevious;
		this.distanceToNext = savedDistance;
	}

	private removeTail() {
		if (!this.tailRect || !this.tailBackup) return;
		this.pasteCoverage(this.tailRect, this.tailBackup);
		const rect = this.tailRect;
		this.tailRect = null;
		this.tailBackup = null;
		this.reblend(rect);
	}

	private curve(start: ToolPoint, end: ToolPoint, before: ToolPoint, after: ToolPoint) {
		const knot = (t: number, a: ToolPoint, b: ToolPoint) => t + Math.max(0.0001, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
		const mix = (a: ToolPoint, b: ToolPoint, ta: number, tb: number, t: number): ToolPoint => {
			const span = tb - ta;
			const wa = (tb - t) / span;
			const wb = (t - ta) / span;
			return {x: a.x * wa + b.x * wb, y: a.y * wa + b.y * wb};
		};
		const t0 = 0;
		const t1 = knot(t0, before, start);
		const t2 = knot(t1, start, end);
		const t3 = knot(t2, end, after);
		const pieces = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2));
		for (let index = 1; index <= pieces; index += 1) {
			const t = t1 + ((t2 - t1) * index) / pieces;
			const a1 = mix(before, start, t0, t1, t);
			const a2 = mix(start, end, t1, t2, t);
			const a3 = mix(end, after, t2, t3, t);
			const b1 = mix(a1, a2, t0, t2, t);
			const b2 = mix(a2, a3, t1, t3, t);
			this.walk(index === pieces ? end : mix(b1, b2, t1, t2, t));
		}
	}

	private walk(point: ToolPoint) {
		if (this.previous) {
			const dx = point.x - this.previous.x;
			const dy = point.y - this.previous.y;
			const length = Math.hypot(dx, dy);
			if (length > 0) {
				let distance = this.distanceToNext;
				while (distance <= length) {
					this.dab({x: this.previous.x + (dx * distance) / length, y: this.previous.y + (dy * distance) / length});
					distance += this.spacing;
				}
				this.distanceToNext = distance - length;
			}
		} else {
			this.dab(point);
			this.distanceToNext = this.spacing;
		}
		this.previous = point;
	}

	private dab(point: ToolPoint) {
		const radius = this.settings.diameter / 2;
		const rect = this.circleBounds(point, radius);
		if (!rect) return;
		this.mark(rect);
		for (let y = rect.y; y < rect.y + rect.height; y += 1) {
			for (let x = rect.x; x < rect.x + rect.width; x += 1) {
				const doc = this.space.toDocument({x: x + 0.5, y: y + 0.5});
				if (!doc || doc.x < 0 || doc.y < 0 || doc.x >= this.space.documentWidth || doc.y >= this.space.documentHeight) continue;
				const selected = this.selection ? this.selection(doc.x, doc.y) : 1;
				if (selected <= 0) continue;
				const falloff = brushFalloff(Math.hypot(doc.x - point.x, doc.y - point.y), radius, this.settings.hardness);
				this.addCoverage(y * this.output.width + x, falloff * selected);
			}
		}
	}

	private addCoverage(index: number, amount: number) {
		if (amount <= 0) return;
		const dab = Math.max(0, Math.min(255, Math.round(amount * 255)));
		if (dab <= 0) return;
		const current = this.coverage[index] ?? 0;
		this.coverage[index] = this.hard ? Math.max(current, dab) : 255 - Math.round(((255 - current) * (255 - dab)) / 255);
		this.touched = true;
	}

	private reblend(rect: PixelRect | null) {
		if (!rect) return;
		const width = this.output.width;
		const color = this.settings.color;
		const opacity = this.settings.opacity;
		for (let y = rect.y; y < rect.y + rect.height; y += 1) {
			for (let x = rect.x; x < rect.x + rect.width; x += 1) {
				const index = y * width + x;
				const covered = (this.coverage[index] ?? 0) / 255;
				const amount = this.settings.healing ? Math.min(1, covered * 0.45) : Math.min(1, covered * opacity);
				const offset = index * 4;
				const sr = this.source.data[offset] ?? 0;
				const sg = this.source.data[offset + 1] ?? 0;
				const sb = this.source.data[offset + 2] ?? 0;
				const sa = this.source.data[offset + 3] ?? 0;
				if (this.cloneAt) {
					const doc = amount > 0 ? this.space.toDocument({x: x + 0.5, y: y + 0.5}) : null;
					const sample = doc ? this.cloneAt(doc.x, doc.y) : null;
					const next = sample ? blendClone({r: sr, g: sg, b: sb, a: sa}, sample, amount) : {r: sr, g: sg, b: sb, a: sa};
					this.output.data[offset] = next.r;
					this.output.data[offset + 1] = next.g;
					this.output.data[offset + 2] = next.b;
					this.output.data[offset + 3] = next.a;
					continue;
				}
				if (this.settings.healing) {
					this.output.data[offset] = Math.round(sr + (HEALING_WASH - sr) * amount);
					this.output.data[offset + 1] = Math.round(sg + (HEALING_WASH - sg) * amount);
					this.output.data[offset + 2] = Math.round(sb + (HEALING_WASH - sb) * amount);
					this.output.data[offset + 3] = Math.round(sa + (255 - sa) * amount);
					continue;
				}
				if (amount <= 0 || this.settings.erasing) {
					this.output.data[offset] = sr;
					this.output.data[offset + 1] = sg;
					this.output.data[offset + 2] = sb;
					this.output.data[offset + 3] = this.settings.erasing && amount > 0 ? Math.round(sa * (1 - amount)) : sa;
					continue;
				}
				this.output.data[offset] = Math.round(sr + (color.r - sr) * amount);
				this.output.data[offset + 1] = Math.round(sg + (color.g - sg) * amount);
				this.output.data[offset + 2] = Math.round(sb + (color.b - sb) * amount);
				this.output.data[offset + 3] = Math.round(sa + (255 - sa) * amount);
			}
		}
		this.dirty = null;
	}

	private mark(rect: PixelRect) {
		this.dirty = this.dirty ? union(this.dirty, rect) : rect;
	}

	private circleBounds(point: ToolPoint, radius: number) {
		return this.documentRectToPixels(point.x - radius, point.y - radius, radius * 2, radius * 2);
	}

	private segmentBounds(from: ToolPoint, to: ToolPoint) {
		const radius = this.settings.diameter / 2 + 1;
		const x = Math.min(from.x, to.x) - radius;
		const y = Math.min(from.y, to.y) - radius;
		return this.documentRectToPixels(x, y, Math.abs(to.x - from.x) + radius * 2, Math.abs(to.y - from.y) + radius * 2);
	}

	private documentRectToPixels(x: number, y: number, width: number, height: number): PixelRect | null {
		const corners = [
			{x, y},
			{x: x + width, y},
			{x, y: y + height},
			{x: x + width, y: y + height},
		];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const corner of corners) {
			const pixel = this.space.toPixel(corner);
			if (!pixel) return null;
			minX = Math.min(minX, pixel.x);
			minY = Math.min(minY, pixel.y);
			maxX = Math.max(maxX, pixel.x);
			maxY = Math.max(maxY, pixel.y);
		}
		const x0 = Math.max(0, Math.floor(minX) - 1);
		const y0 = Math.max(0, Math.floor(minY) - 1);
		const x1 = Math.min(this.output.width - 1, Math.ceil(maxX) + 1);
		const y1 = Math.min(this.output.height - 1, Math.ceil(maxY) + 1);
		if (x1 < x0 || y1 < y0) return null;
		return {x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1};
	}

	private copyCoverage(rect: PixelRect) {
		const copy = new Uint8ClampedArray(rect.width * rect.height);
		for (let y = 0; y < rect.height; y += 1) {
			const start = (rect.y + y) * this.output.width + rect.x;
			copy.set(this.coverage.subarray(start, start + rect.width), y * rect.width);
		}
		return copy;
	}

	private pasteCoverage(rect: PixelRect, copy: Uint8ClampedArray) {
		for (let y = 0; y < rect.height; y += 1) {
			const start = (rect.y + y) * this.output.width + rect.x;
			this.coverage.set(copy.subarray(y * rect.width, y * rect.width + rect.width), start);
		}
	}
};
