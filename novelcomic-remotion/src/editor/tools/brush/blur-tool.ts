import type {PixelBuffer} from '../../pixels/pixel-tools';
import type {ToolPoint} from '../types';
import type {BrushSpace} from './brush-stroke';

/**
 * Blur, Smudge and Liquify, matching Compositor's BlurTool.swift and SmudgeLiquify.swift.
 * Blur samples the layer once, softened by Radius, and paints that through the tip.
 * A later stroke samples again, so going over the same place softens it further.
 * Smudge and Liquify reshape a working copy dab by dab, then that copy is the layer.
 */

export type WarpMode = 'smudge' | 'liquify';

export type PixelSpan = {
	originX: number;
	originY: number;
	ax: number;
	ay: number;
	bx: number;
	by: number;
	/** Document units one layer pixel covers. Blur's radius is divided by this. */
	perPixel: number;
};

const TILE = 64;

export const pixelSpan = (space: BrushSpace): PixelSpan | null => {
	const origin = space.toDocument({x: 0, y: 0});
	const xAxis = space.toDocument({x: 1, y: 0});
	const yAxis = space.toDocument({x: 0, y: 1});
	if (!origin || !xAxis || !yAxis) return null;
	const ax = xAxis.x - origin.x;
	const ay = xAxis.y - origin.y;
	const bx = yAxis.x - origin.x;
	const by = yAxis.y - origin.y;
	const perPixel = Math.max(1e-6, Math.sqrt(Math.abs(ax * by - ay * bx)));
	if (![origin.x, origin.y, ax, ay, bx, by, perPixel].every(Number.isFinite)) return null;
	return {originX: origin.x, originY: origin.y, ax, ay, bx, by, perPixel};
};

/** Canvas radius carried into the layer's own pixels, capped the way BlurTool.blurSample caps sigma. */
export const blurSigma = (radius: number, perPixel: number, side: number) => {
	const clamped = Math.min(50, Math.max(0.5, radius));
	return Math.min(clamped / Math.max(1e-6, perPixel), Math.max(1, side) / 2);
};

const gaussianKernel = (sigma: number) => {
	const radius = Math.max(1, Math.ceil(sigma * 3));
	const kernel = new Float64Array(radius * 2 + 1);
	const denom = 2 * sigma * sigma;
	let sum = 0;
	for (let index = -radius; index <= radius; index += 1) {
		const weight = Math.exp(-(index * index) / denom);
		kernel[index + radius] = weight;
		sum += weight;
	}
	for (let index = 0; index < kernel.length; index += 1) kernel[index] = (kernel[index] ?? 0) / sum;
	return {radius, kernel};
};

type BlurTile = {width: number; height: number; data: Uint8ClampedArray};

const blurTile = (source: PixelBuffer, x0: number, y0: number, sigmaRadius: number, kernel: Float64Array): BlurTile => {
	const width = Math.min(TILE, source.width - x0);
	const height = Math.min(TILE, source.height - y0);
	const radius = sigmaRadius;
	const inX0 = x0 - radius;
	const inY0 = y0 - radius;
	const inWidth = width + radius * 2;
	const inHeight = height + radius * 2;
	const horizontal = new Float32Array(inWidth * inHeight * 4);
	const src = source.data;
	for (let y = 0; y < inHeight; y += 1) {
		const sourceY = inY0 + y;
		for (let x = 0; x < inWidth; x += 1) {
			let red = 0;
			let green = 0;
			let blue = 0;
			let alpha = 0;
			for (let offset = -radius; offset <= radius; offset += 1) {
				const sourceX = inX0 + x + offset;
				const weight = kernel[offset + radius] ?? 0;
				if (sourceY < 0 || sourceY >= source.height || sourceX < 0 || sourceX >= source.width) continue;
				const index = (sourceY * source.width + sourceX) * 4;
				const cover = (src[index + 3] ?? 0) / 255;
				red += (src[index] ?? 0) * cover * weight;
				green += (src[index + 1] ?? 0) * cover * weight;
				blue += (src[index + 2] ?? 0) * cover * weight;
				alpha += cover * weight;
			}
			const index = (y * inWidth + x) * 4;
			horizontal[index] = red;
			horizontal[index + 1] = green;
			horizontal[index + 2] = blue;
			horizontal[index + 3] = alpha;
		}
	}
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let red = 0;
			let green = 0;
			let blue = 0;
			let alpha = 0;
			for (let offset = -radius; offset <= radius; offset += 1) {
				const weight = kernel[offset + radius] ?? 0;
				const index = ((y + radius + offset) * inWidth + (x + radius)) * 4;
				red += (horizontal[index] ?? 0) * weight;
				green += (horizontal[index + 1] ?? 0) * weight;
				blue += (horizontal[index + 2] ?? 0) * weight;
				alpha += (horizontal[index + 3] ?? 0) * weight;
			}
			const index = (y * width + x) * 4;
			if (alpha <= 1e-4) continue;
			data[index] = Math.round(Math.min(255, red / alpha));
			data[index + 1] = Math.round(Math.min(255, green / alpha));
			data[index + 2] = Math.round(Math.min(255, blue / alpha));
			data[index + 3] = Math.round(Math.min(255, alpha * 255));
		}
	}
	return {width, height, data};
};

/** Reads the layer's pixels softened once, in place. Outside the layer there is nothing to paint. */
export const createBlurSampler = (source: PixelBuffer, space: BrushSpace, sigma: number) => {
	const {radius, kernel} = gaussianKernel(Math.max(0.01, sigma));
	const columns = Math.max(1, Math.ceil(source.width / TILE));
	const tiles = new Map<number, BlurTile>();
	const tileAt = (tx: number, ty: number) => {
		const key = ty * columns + tx;
		const cached = tiles.get(key);
		if (cached) return cached;
		const tile = blurTile(source, tx * TILE, ty * TILE, radius, kernel);
		tiles.set(key, tile);
		return tile;
	};
	return (documentX: number, documentY: number) => {
		const pixel = space.toPixel({x: documentX, y: documentY});
		if (!pixel) return null;
		const x = Math.floor(pixel.x);
		const y = Math.floor(pixel.y);
		if (x < 0 || y < 0 || x >= source.width || y >= source.height) return null;
		const tx = Math.floor(x / TILE);
		const ty = Math.floor(y / TILE);
		const tile = tileAt(tx, ty);
		const localX = x - tx * TILE;
		const localY = y - ty * TILE;
		if (localX < 0 || localY < 0 || localX >= tile.width || localY >= tile.height) return null;
		const index = (localY * tile.width + localX) * 4;
		return {
			r: tile.data[index] ?? 0,
			g: tile.data[index + 1] ?? 0,
			b: tile.data[index + 2] ?? 0,
			a: tile.data[index + 3] ?? 0,
		};
	};
};

type Rect = {x: number; y: number; width: number; height: number};

const union = (left: Rect, right: Rect): Rect => {
	const x = Math.min(left.x, right.x);
	const y = Math.min(left.y, right.y);
	return {
		x,
		y,
		width: Math.max(left.x + left.width, right.x + right.width) - x,
		height: Math.max(left.y + left.height, right.y + right.height) - y,
	};
};

const sampleBilinear = (source: PixelBuffer, x: number, y: number) => {
	if (x < 0 || y < 0 || x >= source.width || y >= source.height) return {r: 0, g: 0, b: 0, a: 0};
	const x0 = Math.max(0, Math.min(source.width - 1, Math.floor(x)));
	const y0 = Math.max(0, Math.min(source.height - 1, Math.floor(y)));
	const x1 = Math.min(source.width - 1, x0 + 1);
	const y1 = Math.min(source.height - 1, y0 + 1);
	const fx = x1 === x0 ? 0 : x - x0;
	const fy = y1 === y0 ? 0 : y - y0;
	const at = (px: number, py: number) => {
		const index = (py * source.width + px) * 4;
		return [source.data[index] ?? 0, source.data[index + 1] ?? 0, source.data[index + 2] ?? 0, source.data[index + 3] ?? 0];
	};
	const a = at(x0, y0);
	const b = at(x1, y0);
	const c = at(x0, y1);
	const d = at(x1, y1);
	const mix = (channel: number) =>
		Math.round(
			(a[channel] ?? 0) * (1 - fx) * (1 - fy) +
				(b[channel] ?? 0) * fx * (1 - fy) +
				(c[channel] ?? 0) * (1 - fx) * fy +
				(d[channel] ?? 0) * fx * fy,
		);
	return {r: mix(0), g: mix(1), b: mix(2), a: mix(3)};
};

/**
 * One Smudge or Liquify gesture. On an upright, evenly scaled layer the working copy is the
 * layer's own pixels, so a stroke commits exactly what the dabs wrote. A rotated layer is
 * warped in document space and sampled back along the stroke.
 */
export class WarpStroke {
	private readonly sourceLayer: PixelBuffer;
	private readonly space: BrushSpace;
	private readonly direct: boolean;
	private readonly originX: number;
	private readonly originY: number;
	private readonly scaleX: number;
	private readonly scaleY: number;
	private readonly width: number;
	private readonly height: number;
	private readonly pixels: Uint8ClampedArray;
	private readonly workDiameter: number;
	private readonly hardness: number;
	private readonly strength: number;
	private readonly spacing: number;
	private readonly radius: number;
	private readonly mode: WarpMode;
	private carried: Float32Array = new Float32Array();
	private scratch: Float32Array = new Float32Array();
	private last: ToolPoint | null = null;
	private dirty: Rect | null = null;
	private touched = false;

	constructor(
		source: PixelBuffer,
		space: BrushSpace,
		mode: WarpMode,
		settings: {diameter: number; hardness: number; opacity: number},
	) {
		const span = pixelSpan(space);
		if (!span) throw new Error('图层位置无效，无法涂抹。');
		this.sourceLayer = source;
		this.space = space;
		this.mode = mode;
		this.hardness = Math.min(0.98, Math.max(0, settings.hardness));
		this.strength = Math.min(1, Math.max(0.01, settings.opacity));
		const uniform =
			Math.abs(span.ay) < 1e-4 &&
			Math.abs(span.bx) < 1e-4 &&
			span.ax > 1e-4 &&
			span.by > 1e-4 &&
			Math.abs(span.ax - span.by) <= 1e-3 * Math.max(1, Math.abs(span.ax));
		if (uniform) {
			this.direct = true;
			this.originX = span.originX;
			this.originY = span.originY;
			this.scaleX = span.ax;
			this.scaleY = span.by;
			this.width = source.width;
			this.height = source.height;
			this.pixels = new Uint8ClampedArray(source.data);
			this.workDiameter = Math.max(2, settings.diameter / span.ax);
		} else {
			const raster = rasterizeLayer(source, space, settings.diameter);
			this.direct = false;
			this.originX = raster.originX;
			this.originY = raster.originY;
			this.scaleX = 1;
			this.scaleY = 1;
			this.width = raster.width;
			this.height = raster.height;
			this.pixels = raster.pixels;
			this.workDiameter = Math.max(2, settings.diameter);
		}
		this.radius = Math.ceil(this.workDiameter / 2);
		const minSpacing = 1 / (this.direct ? this.scaleX : 1);
		this.spacing = Math.max(minSpacing, this.workDiameter * (mode === 'smudge' ? 0.005 : 0.025));
	}

	get changed() {
		return this.touched;
	}

	/** The layer as the stroke has reshaped it so far. */
	preview(): PixelBuffer {
		if (this.direct) return {width: this.width, height: this.height, data: this.pixels};
		return this.resample();
	}

	commitPixels(selection?: (documentX: number, documentY: number) => number): PixelBuffer {
		const base = this.preview();
		const data = new Uint8ClampedArray(base.data);
		const width = base.width;
		const height = base.height;
		if (selection) {
			const original = this.sourceLayer.data;
			for (let y = 0; y < height; y += 1) {
				for (let x = 0; x < width; x += 1) {
					const doc = this.space.toDocument({x: x + 0.5, y: y + 0.5});
					if (!doc) continue;
					const covered = selection(doc.x, doc.y);
					if (covered >= 1) continue;
					const index = (y * width + x) * 4;
					for (let channel = 0; channel < 4; channel += 1) {
						const before = original[index + channel] ?? 0;
						data[index + channel] = covered <= 0 ? before : Math.round(before + ((data[index + channel] ?? 0) - before) * covered);
					}
				}
			}
		}
		return {width, height, data};
	}

	append(point: ToolPoint) {
		if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
		const here = this.toWork(point);
		if (!this.last) {
			this.last = here;
			if (this.mode === 'smudge') this.pickUp(here);
			return;
		}
		const from = this.last;
		const distance = Math.hypot(here.x - from.x, here.y - from.y);
		if (distance < this.spacing) return;
		const steps = Math.max(1, Math.ceil(distance / this.spacing));
		let previous = from;
		for (let step = 1; step <= steps; step += 1) {
			const t = step / steps;
			const next = {x: from.x + (here.x - from.x) * t, y: from.y + (here.y - from.y) * t};
			if (this.mode === 'smudge') this.smudge(next);
			else this.push(previous, next);
			previous = next;
		}
		this.last = here;
	}

	private toWork(point: ToolPoint): ToolPoint {
		if (this.direct) return {x: (point.x - this.originX) / this.scaleX, y: (point.y - this.originY) / this.scaleY};
		return {x: point.x - this.originX, y: point.y - this.originY};
	}

	private toDocument(point: ToolPoint): ToolPoint {
		if (this.direct) return {x: this.originX + point.x * this.scaleX, y: this.originY + point.y * this.scaleY};
		return {x: this.originX + point.x, y: this.originY + point.y};
	}

	private weight(u: number) {
		if (u >= 1) return 0;
		if (u <= this.hardness) return 1;
		const t = (1 - u) / (1 - this.hardness);
		return t * t * (3 - 2 * t);
	}

	private mark(work: ToolPoint) {
		const doc = this.toDocument(work);
		const reach = (this.direct ? this.scaleX : 1) * (this.workDiameter / 2) + 4;
		const rect = {x: doc.x - reach, y: doc.y - reach, width: reach * 2, height: reach * 2};
		this.dirty = this.dirty ? union(this.dirty, rect) : rect;
	}

	private pickUp(center: ToolPoint) {
		const radius = this.radius;
		const side = radius * 2 + 1;
		this.carried = new Float32Array(side * side * 4);
		const cx = Math.round(center.x);
		const cy = Math.round(center.y);
		for (let dy = -radius; dy <= radius; dy += 1) {
			const y = cy + dy;
			if (y < 0 || y >= this.height) continue;
			for (let dx = -radius; dx <= radius; dx += 1) {
				const x = cx + dx;
				if (x < 0 || x >= this.width) continue;
				const pixel = (y * this.width + x) * 4;
				const carried = ((dy + radius) * side + dx + radius) * 4;
				for (let channel = 0; channel < 4; channel += 1) this.carried[carried + channel] = this.pixels[pixel + channel] ?? 0;
			}
		}
	}

	private smudge(center: ToolPoint) {
		const radius = this.radius;
		const side = radius * 2 + 1;
		const cx = Math.round(center.x);
		const cy = Math.round(center.y);
		const invR = 1 / (this.workDiameter / 2);
		for (let dy = -radius; dy <= radius; dy += 1) {
			const y = cy + dy;
			if (y < 0 || y >= this.height) continue;
			for (let dx = -radius; dx <= radius; dx += 1) {
				const x = cx + dx;
				if (x < 0 || x >= this.width) continue;
				const weight = this.weight(Math.hypot(dx, dy) * invR);
				if (weight <= 0) continue;
				const pixel = (y * this.width + x) * 4;
				const carried = ((dy + radius) * side + dx + radius) * 4;
				for (let channel = 0; channel < 4; channel += 1) {
					const under = this.pixels[pixel + channel] ?? 0;
					const painted = under + ((this.carried[carried + channel] ?? 0) - under) * weight * this.strength;
					this.pixels[pixel + channel] = Math.max(0, Math.min(255, Math.round(painted)));
					this.carried[carried + channel] = painted;
				}
				this.touched = true;
			}
		}
		this.mark(center);
	}

	private push(from: ToolPoint, to: ToolPoint) {
		const radius = this.radius;
		const moveX = (to.x - from.x) * this.strength;
		const moveY = (to.y - from.y) * this.strength;
		const margin = Math.ceil(Math.max(Math.abs(moveX), Math.abs(moveY))) + 2;
		const cx = Math.round(to.x);
		const cy = Math.round(to.y);
		const x0 = Math.max(0, cx - radius - margin);
		const x1 = Math.min(this.width - 1, cx + radius + margin);
		const y0 = Math.max(0, cy - radius - margin);
		const y1 = Math.min(this.height - 1, cy + radius + margin);
		if (x0 > x1 || y0 > y1) return;
		const copyWidth = x1 - x0 + 1;
		const copyHeight = y1 - y0 + 1;
		const needed = copyWidth * copyHeight * 4;
		if (this.scratch.length < needed) this.scratch = new Float32Array(needed);
		for (let y = 0; y < copyHeight; y += 1) {
			for (let x = 0; x < copyWidth; x += 1) {
				const pixel = ((y + y0) * this.width + x + x0) * 4;
				const sample = (y * copyWidth + x) * 4;
				for (let channel = 0; channel < 4; channel += 1) this.scratch[sample + channel] = this.pixels[pixel + channel] ?? 0;
			}
		}
		const invR = 1 / (this.workDiameter / 2);
		for (let dy = -radius; dy <= radius; dy += 1) {
			const y = cy + dy;
			if (y < y0 || y > y1) continue;
			for (let dx = -radius; dx <= radius; dx += 1) {
				const x = cx + dx;
				if (x < x0 || x > x1) continue;
				const weight = this.weight(Math.hypot(dx, dy) * invR);
				if (weight <= 0) continue;
				const sx = Math.min(copyWidth - 1, Math.max(0, x - x0 - moveX * weight));
				const sy = Math.min(copyHeight - 1, Math.max(0, y - y0 - moveY * weight));
				const ix = Math.min(copyWidth - 2, Math.floor(sx));
				const iy = Math.min(copyHeight - 2, Math.floor(sy));
				if (ix < 0 || iy < 0) continue;
				const fx = sx - ix;
				const fy = sy - iy;
				const pixel = (y * this.width + x) * 4;
				const s00 = (iy * copyWidth + ix) * 4;
				const s10 = s00 + 4;
				const s01 = s00 + copyWidth * 4;
				const s11 = s01 + 4;
				for (let channel = 0; channel < 4; channel += 1) {
					const top = (this.scratch[s00 + channel] ?? 0) + ((this.scratch[s10 + channel] ?? 0) - (this.scratch[s00 + channel] ?? 0)) * fx;
					const bottom = (this.scratch[s01 + channel] ?? 0) + ((this.scratch[s11 + channel] ?? 0) - (this.scratch[s01 + channel] ?? 0)) * fx;
					this.pixels[pixel + channel] = Math.max(0, Math.min(255, Math.round(top + (bottom - top) * fy)));
				}
				this.touched = true;
			}
		}
		this.mark(to);
	}

	private resample(): PixelBuffer {
		const width = this.sourceLayer.width;
		const height = this.sourceLayer.height;
		const data = new Uint8ClampedArray(this.sourceLayer.data);
		const dirty = this.dirty;
		if (!dirty) return {width, height, data};
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const doc = this.space.toDocument({x: x + 0.5, y: y + 0.5});
				if (!doc || doc.x < dirty.x || doc.y < dirty.y || doc.x >= dirty.x + dirty.width || doc.y >= dirty.y + dirty.height) continue;
				const workX = doc.x - this.originX;
				const workY = doc.y - this.originY;
				const color = sampleBilinear({width: this.width, height: this.height, data: this.pixels}, workX, workY);
				const index = (y * width + x) * 4;
				data[index] = color.r;
				data[index + 1] = color.g;
				data[index + 2] = color.b;
				data[index + 3] = color.a;
			}
		}
		return {width, height, data};
	}
}

const rasterizeLayer = (source: PixelBuffer, space: BrushSpace, diameter: number) => {
	const corners = [
		{x: 0, y: 0},
		{x: source.width, y: 0},
		{x: 0, y: source.height},
		{x: source.width, y: source.height},
	].map((point) => space.toDocument(point));
	if (corners.some((corner) => !corner)) throw new Error('图层位置无效，无法涂抹。');
	const margin = Math.ceil(diameter / 2) + 4;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const corner of corners) {
		if (!corner) continue;
		minX = Math.min(minX, corner.x);
		minY = Math.min(minY, corner.y);
		maxX = Math.max(maxX, corner.x);
		maxY = Math.max(maxY, corner.y);
	}
	const originX = Math.floor(minX - margin);
	const originY = Math.floor(minY - margin);
	const width = Math.ceil(maxX + margin) - originX;
	const height = Math.ceil(maxY + margin) - originY;
	if (width < 1 || height < 1 || width * height > 16_000_000) throw new Error('图像太大，无法涂抹。');
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const pixel = space.toPixel({x: originX + x + 0.5, y: originY + y + 0.5});
			if (!pixel) continue;
			const color = sampleBilinear(source, pixel.x, pixel.y);
			const index = (y * width + x) * 4;
			pixels[index] = color.r;
			pixels[index + 1] = color.g;
			pixels[index + 2] = color.b;
			pixels[index + 3] = color.a;
		}
	}
	return {originX, originY, width, height, pixels};
};
