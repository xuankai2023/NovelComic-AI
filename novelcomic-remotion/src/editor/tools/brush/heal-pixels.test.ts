import {describe, expect, it} from 'vitest';
import {createPixelBuffer} from '../../pixels/pixel-tools';
import {BrushStroke, identityBrushSpace} from './brush-stroke';
import type {SpotHealingMode} from './brush-settings';

/** Vertical gray stripes with a red blemish, matching Compositor's SpotHealingTests. */
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

const pixel = (buffer: {width: number; data: Uint8ClampedArray}, x: number, y: number) => {
	const offset = (y * buffer.width + x) * 4;
	return [buffer.data[offset], buffer.data[offset + 1], buffer.data[offset + 2], buffer.data[offset + 3]];
};

describe('spot healing', () => {
	it.each(['content-aware', 'create-texture', 'proximity-match'] as const)(
		'heals the blemish under the brush and nothing else (%s)',
		(mode: SpotHealingMode) => {
			const source = blemished();
			const before = new Uint8ClampedArray(source.data);
			const stroke = new BrushStroke(
				source,
				{diameter: 24, hardness: 1, opacity: 1, erasing: false, healing: true, healingMode: mode, color: {r: 0, g: 0, b: 0}},
				identityBrushSpace(120, 80),
			);
			stroke.append({x: 60, y: 40});
			stroke.append({x: 60.5, y: 40});
			const washing = pixel(stroke.pixels, 60, 40);
			expect(washing[0]! - washing[1]!).toBeGreaterThan(30);
			stroke.flush();
			stroke.heal(1);
			for (const [x, y] of [
				[60, 40],
				[56, 36],
				[64, 44],
			] as const) {
				const healed = pixel(stroke.pixels, x, y);
				expect(healed[0]! - healed[1]!, `${mode} (${x}, ${y}) is ${healed.join(',')}`).toBeLessThan(30);
				expect(healed[1]).toBeGreaterThanOrEqual(80);
				expect(healed[1]).toBeLessThanOrEqual(130);
				expect(healed[3]).toBe(255);
			}
			for (const [x, y] of [
				[10, 10],
				[90, 40],
				[30, 40],
				[60, 10],
				[60, 70],
			] as const) {
				const offset = (y * 120 + x) * 4;
				expect(Array.from(stroke.pixels.data.subarray(offset, offset + 4)), `${mode} (${x}, ${y})`).toEqual(
					Array.from(before.subarray(offset, offset + 4)),
				);
			}
			expect(Array.from(source.data.subarray(0, 16))).toEqual(Array.from(before.subarray(0, 16)));
		},
	);
});
