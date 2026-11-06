/**
 * Spot healing, ported from Compositor's HealPixels.c.
 * The kernel runs on premultiplied RGBA. Callers that store straight alpha
 * convert around it; fully opaque pixels are unchanged by that conversion.
 *
 * mode 0 Content-Aware: the nearby patch whose ring best matches the spot.
 * mode 1 Create Texture: a smooth fill from the edges, plus matching grain.
 * mode 2 Proximity Match: like 0, preferring the closest good patch.
 * Copied texture is shifted by a membrane so it meets the surrounding tone.
 */

const OUTSIDE = 0;
const RING = 1;
const HOLE = 2;

const lround = (value: number) => {
	if (!Number.isFinite(value)) return 0;
	return Math.sign(value) * Math.round(Math.abs(value));
};

const healHash = (value: number) => {
	let x = value >>> 0;
	x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
	x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
	return (x ^ (x >>> 16)) >>> 0;
};

const healUnit = (key: number) => (healHash(key) >>> 8) / 16777216;

/** Half-open bounds of nonzero coverage. All zero when nothing is marked. */
export const healCoverageBounds = (gray: ArrayLike<number>, width: number, height: number, stride = width) => {
	let x0 = width;
	let y0 = height;
	let x1 = 0;
	let y1 = 0;
	for (let y = 0; y < height; y += 1) {
		const row = y * stride;
		for (let x = 0; x < width; x += 1) {
			if (!gray[row + x]) continue;
			if (x < x0) x0 = x;
			if (x + 1 > x1) x1 = x + 1;
			if (y < y0) y0 = y;
			if (y + 1 > y1) y1 = y + 1;
		}
	}
	if (x1 <= x0 || y1 <= y0) return [0, 0, 0, 0] as const;
	return [x0, y0, x1, y1] as const;
};

/** Order matches Compositor's SpotHealingMode.allCases, which is the kernel's mode number. */
export const healingModeIndex = (mode: 'content-aware' | 'create-texture' | 'proximity-match' | undefined) =>
	mode === 'create-texture' ? 1 : mode === 'proximity-match' ? 2 : 0;

const healScore = (
	rgba: Uint8Array,
	stride: number,
	role: Uint8Array,
	wx0: number,
	wy0: number,
	ww: number,
	wh: number,
	dx: number,
	dy: number,
	imageWidth: number,
	imageHeight: number,
) => {
	if (Math.abs(dx) < ww && Math.abs(dy) < wh) return Number.POSITIVE_INFINITY;
	if (wx0 + dx < 0 || wy0 + dy < 0 || wx0 + ww + dx > imageWidth || wy0 + wh + dy > imageHeight) return Number.POSITIVE_INFINITY;
	let sum = 0;
	let count = 0;
	for (let y = 0; y < wh; y += 1) {
		for (let x = 0; x < ww; x += 1) {
			if (role[y * ww + x] !== RING) continue;
			const target = (wy0 + y) * stride + (wx0 + x) * 4;
			const source = (wy0 + y + dy) * stride + (wx0 + x + dx) * 4;
			for (let channel = 0; channel < 4; channel += 1) {
				const delta = (rgba[target + channel] ?? 0) - (rgba[source + channel] ?? 0);
				sum += delta * delta;
			}
			count += 1;
		}
	}
	return count ? sum / count : Number.POSITIVE_INFINITY;
};

/** Smooth values over HOLE pixels, fixed to the RING around them. */
const healSolve = (value: Float64Array, role: Uint8Array, width: number, height: number, depth: number) => {
	let iterations = 300;
	if (width > 32 && height > 32 && depth < 16) {
		const coarseWidth = Math.trunc((width + 1) / 2);
		const coarseHeight = Math.trunc((height + 1) / 2);
		const coarse = new Float64Array(coarseWidth * coarseHeight * 4);
		const coarseRole = new Uint8Array(coarseWidth * coarseHeight);
		for (let y = 0; y < coarseHeight; y += 1) {
			for (let x = 0; x < coarseWidth; x += 1) {
				let known = 0;
				let hole = 0;
				const knownSum = [0, 0, 0, 0];
				const holeSum = [0, 0, 0, 0];
				for (let j = 0; j < 2; j += 1) {
					for (let i = 0; i < 2; i += 1) {
						const fx = x * 2 + i;
						const fy = y * 2 + j;
						if (fx >= width || fy >= height) continue;
						const index = fy * width + fx;
						if (role[index] === RING) {
							known += 1;
							for (let channel = 0; channel < 4; channel += 1) knownSum[channel] += value[index * 4 + channel] ?? 0;
						} else if (role[index] === HOLE) {
							hole += 1;
							for (let channel = 0; channel < 4; channel += 1) holeSum[channel] += value[index * 4 + channel] ?? 0;
						}
					}
				}
				const coarseIndex = y * coarseWidth + x;
				if (known) {
					coarseRole[coarseIndex] = RING;
					for (let channel = 0; channel < 4; channel += 1) coarse[coarseIndex * 4 + channel] = knownSum[channel]! / known;
				} else if (hole) {
					coarseRole[coarseIndex] = HOLE;
					for (let channel = 0; channel < 4; channel += 1) coarse[coarseIndex * 4 + channel] = holeSum[channel]! / hole;
				}
			}
		}
		healSolve(coarse, coarseRole, coarseWidth, coarseHeight, depth + 1);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const index = y * width + x;
				const coarseIndex = Math.trunc(y / 2) * coarseWidth + Math.trunc(x / 2);
				if (role[index] === HOLE && coarseRole[coarseIndex] === HOLE) {
					value.set(coarse.subarray(coarseIndex * 4, coarseIndex * 4 + 4), index * 4);
				}
			}
		}
		iterations = 40;
	}
	const omega = 1.8;
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const index = y * width + x;
				if (role[index] !== HOLE) continue;
				const sum = [0, 0, 0, 0];
				let count = 0;
				const neighbors = [
					[x - 1, y],
					[x + 1, y],
					[x, y - 1],
					[x, y + 1],
				];
				for (const [nx, ny] of neighbors) {
					if (nx === undefined || ny === undefined || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
					const neighbor = ny * width + nx;
					if (role[neighbor] === OUTSIDE) continue;
					for (let channel = 0; channel < 4; channel += 1) sum[channel] += value[neighbor * 4 + channel] ?? 0;
					count += 1;
				}
				if (!count) continue;
				for (let channel = 0; channel < 4; channel += 1) {
					const current = value[index * 4 + channel] ?? 0;
					value[index * 4 + channel] = current + omega * ((sum[channel] ?? 0) / count - current);
				}
			}
		}
	}
};

/**
 * Heals premultiplied RGBA in place. `coverage` is width × height bytes, 0–255.
 * Returns 0, or -1 when the buffers cannot be used.
 */
export const spotHeal = (
	rgba: Uint8Array,
	coverage: ArrayLike<number>,
	width: number,
	height: number,
	stride: number,
	opacity: number,
	mode: number,
	seed: number,
) => {
	if (width < 1 || height < 1 || stride < width * 4) return -1;
	const bounds = healCoverageBounds(coverage, width, height, width);
	if (bounds[2] <= bounds[0]) return 0;
	const spotWidth = bounds[2] - bounds[0];
	const spotHeight = bounds[3] - bounds[1];
	const size = Math.max(spotWidth, spotHeight);
	let ring = Math.trunc(size / 8);
	if (ring < 2) ring = 2;
	if (ring > 16) ring = 16;
	const wx0 = Math.max(0, bounds[0] - ring);
	const wy0 = Math.max(0, bounds[1] - ring);
	const wx1 = Math.min(width, bounds[2] + ring);
	const wy1 = Math.min(height, bounds[3] + ring);
	const ww = wx1 - wx0;
	const wh = wy1 - wy0;
	const count = ww * wh;
	const role = new Uint8Array(count);
	const near = new Uint8Array(count);
	const prefix = new Int32Array(Math.max(ww, wh) + 1);
	const value = new Float64Array(count * 4);
	for (let y = 0; y < wh; y += 1) {
		for (let x = 0; x < ww; x += 1) {
			role[y * ww + x] = coverage[(wy0 + y) * width + (wx0 + x)] ? HOLE : OUTSIDE;
		}
	}
	for (let y = 0; y < wh; y += 1) {
		prefix[0] = 0;
		for (let x = 0; x < ww; x += 1) prefix[x + 1] = (prefix[x] ?? 0) + (role[y * ww + x] === HOLE ? 1 : 0);
		for (let x = 0; x < ww; x += 1) {
			const lo = Math.max(0, x - ring);
			const hi = Math.min(ww, x + ring + 1);
			near[y * ww + x] = (prefix[hi] ?? 0) - (prefix[lo] ?? 0) > 0 ? 1 : 0;
		}
	}
	for (let x = 0; x < ww; x += 1) {
		prefix[0] = 0;
		for (let y = 0; y < wh; y += 1) prefix[y + 1] = (prefix[y] ?? 0) + (near[y * ww + x] ?? 0);
		for (let y = 0; y < wh; y += 1) {
			const lo = Math.max(0, y - ring);
			const hi = Math.min(wh, y + ring + 1);
			const index = y * ww + x;
			if (role[index] === OUTSIDE && (prefix[hi] ?? 0) - (prefix[lo] ?? 0) > 0) role[index] = RING;
		}
	}
	let ringCount = 0;
	for (let index = 0; index < count; index += 1) if (role[index] === RING) ringCount += 1;
	if (!ringCount) return 0;

	let offsetX = 0;
	let offsetY = 0;
	let haveSource = false;
	if (mode !== 1) {
		const factors = [1.05, 1.35, 1.75, 2.25, 2.8];
		const factorCount = mode === 2 ? 2 : 5;
		let best = Number.POSITIVE_INFINITY;
		for (let factor = 0; factor < factorCount; factor += 1) {
			for (let angleIndex = 0; angleIndex < 24; angleIndex += 1) {
				const angle = (angleIndex * Math.PI) / 12;
				const dx = lround(Math.cos(angle) * factors[factor]! * ww);
				const dy = lround(Math.sin(angle) * factors[factor]! * wh);
				let score = healScore(rgba, stride, role, wx0, wy0, ww, wh, dx, dy, width, height);
				if (!Number.isFinite(score)) continue;
				score *= mode === 2 ? 1 + 0.6 * factor : 1 + 0.1 * factor;
				if (score < best) {
					best = score;
					offsetX = dx;
					offsetY = dy;
				}
			}
		}
		if (Number.isFinite(best)) {
			const centerX = offsetX;
			const centerY = offsetY;
			let refined = healScore(rgba, stride, role, wx0, wy0, ww, wh, centerX, centerY, width, height);
			for (let j = -3; j <= 3; j += 1) {
				for (let i = -3; i <= 3; i += 1) {
					const score = healScore(rgba, stride, role, wx0, wy0, ww, wh, centerX + i, centerY + j, width, height);
					if (score < refined) {
						refined = score;
						offsetX = centerX + i;
						offsetY = centerY + j;
					}
				}
			}
			haveSource = true;
		}
	}

	const mean = [0, 0, 0, 0];
	const detail = [0, 0, 0];
	for (let y = 0; y < wh; y += 1) {
		for (let x = 0; x < ww; x += 1) {
			const index = y * ww + x;
			if (role[index] !== RING) continue;
			const ix = wx0 + x;
			const iy = wy0 + y;
			const target = iy * stride + ix * 4;
			const source = haveSource ? (iy + offsetY) * stride + (ix + offsetX) * 4 : -1;
			for (let channel = 0; channel < 4; channel += 1) {
				const difference = (rgba[target + channel] ?? 0) - (source >= 0 ? (rgba[source + channel] ?? 0) : 0);
				value[index * 4 + channel] = difference;
				mean[channel] += difference;
			}
			if (!haveSource) {
				for (let channel = 0; channel < 3; channel += 1) {
					let around = 0;
					let neighbors = 0;
					const offsets = [
						[ix - 1, iy],
						[ix + 1, iy],
						[ix, iy - 1],
						[ix, iy + 1],
					];
					for (const [nx, ny] of offsets) {
						if (nx === undefined || ny === undefined || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
						around += rgba[ny * stride + nx * 4 + channel] ?? 0;
						neighbors += 1;
					}
					if (neighbors) {
						const delta = (rgba[target + channel] ?? 0) - around / neighbors;
						detail[channel] += delta * delta;
					}
				}
			}
		}
	}
	for (let channel = 0; channel < 4; channel += 1) mean[channel] = (mean[channel] ?? 0) / ringCount;
	for (let index = 0; index < count; index += 1) {
		if (role[index] !== HOLE) continue;
		for (let channel = 0; channel < 4; channel += 1) value[index * 4 + channel] = mean[channel] ?? 0;
	}
	healSolve(value, role, ww, wh, 0);
	for (let channel = 0; channel < 3; channel += 1) detail[channel] = Math.sqrt((detail[channel] ?? 0) / ringCount) * 0.9;

	for (let y = 0; y < wh; y += 1) {
		for (let x = 0; x < ww; x += 1) {
			const index = y * ww + x;
			if (role[index] !== HOLE) continue;
			const ix = wx0 + x;
			const iy = wy0 + y;
			const target = iy * stride + ix * 4;
			const source = haveSource ? (iy + offsetY) * stride + (ix + offsetX) * 4 : -1;
			const amount = ((coverage[iy * width + ix] ?? 0) / 255) * opacity;
			let grain = 0;
			if (!haveSource) {
				const key = healHash((seed >>> 0) ^ healHash((iy * width + ix) >>> 0));
				const u1 = healUnit(key);
				const u2 = healUnit(key ^ 0x68e31da4);
				grain = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
			}
			const out = [0, 0, 0, 0];
			for (let channel = 0; channel < 4; channel += 1) {
				const healed =
					(source >= 0 ? (rgba[source + channel] ?? 0) : 0) +
					(value[index * 4 + channel] ?? 0) +
					(channel < 3 ? grain * (detail[channel] ?? 0) : 0);
				out[channel] = (rgba[target + channel] ?? 0) + (healed - (rgba[target + channel] ?? 0)) * amount;
			}
			let alpha = out[3] ?? 0;
			if (alpha < 0) alpha = 0;
			else if (alpha > 255) alpha = 255;
			const storedAlpha = lround(alpha);
			rgba[target + 3] = storedAlpha;
			for (let channel = 0; channel < 3; channel += 1) {
				let channelValue = out[channel] ?? 0;
				if (channelValue < 0) channelValue = 0;
				else if (channelValue > storedAlpha) channelValue = storedAlpha;
				rgba[target + channel] = lround(channelValue);
			}
		}
	}
	return 0;
};

const premultiply = (rgba: Uint8Array) => {
	for (let index = 0; index < rgba.length; index += 4) {
		const alpha = rgba[index + 3] ?? 0;
		if (alpha === 255) continue;
		if (alpha === 0) {
			rgba[index] = 0;
			rgba[index + 1] = 0;
			rgba[index + 2] = 0;
			continue;
		}
		rgba[index] = Math.round(((rgba[index] ?? 0) * alpha) / 255);
		rgba[index + 1] = Math.round(((rgba[index + 1] ?? 0) * alpha) / 255);
		rgba[index + 2] = Math.round(((rgba[index + 2] ?? 0) * alpha) / 255);
	}
};

const writeStraight = (target: Uint8Array | Uint8ClampedArray, offset: number, rgba: Uint8Array) => {
	const alpha = rgba[offset + 3] ?? 0;
	if (alpha <= 0) {
		target[offset] = 0;
		target[offset + 1] = 0;
		target[offset + 2] = 0;
		target[offset + 3] = 0;
		return;
	}
	if (alpha >= 255) {
		target[offset] = rgba[offset] ?? 0;
		target[offset + 1] = rgba[offset + 1] ?? 0;
		target[offset + 2] = rgba[offset + 2] ?? 0;
		target[offset + 3] = 255;
		return;
	}
	const scale = 255 / alpha;
	target[offset] = Math.max(0, Math.min(255, Math.round((rgba[offset] ?? 0) * scale)));
	target[offset + 1] = Math.max(0, Math.min(255, Math.round((rgba[offset + 1] ?? 0) * scale)));
	target[offset + 2] = Math.max(0, Math.min(255, Math.round((rgba[offset + 2] ?? 0) * scale)));
	target[offset + 3] = alpha;
};

/**
 * Heals a straight-alpha buffer in place. Pixels with no coverage are left untouched.
 * Returns 0, or -1 when the kernel cannot run.
 */
export const healCoverage = (
	rgba: Uint8Array | Uint8ClampedArray,
	coverage: ArrayLike<number>,
	width: number,
	height: number,
	opacity: number,
	mode: number,
	seed: number,
) => {
	if (width < 1 || height < 1 || rgba.length < width * height * 4) return -1;
	const working = new Uint8Array(width * height * 4);
	working.set(rgba.subarray(0, width * height * 4));
	premultiply(working);
	const status = spotHeal(working, coverage, width, height, width * 4, opacity, mode, seed);
	if (status !== 0) return status;
	for (let index = 0; index < width * height; index += 1) {
		if (!coverage[index]) continue;
		writeStraight(rgba, index * 4, working);
	}
	return 0;
};
