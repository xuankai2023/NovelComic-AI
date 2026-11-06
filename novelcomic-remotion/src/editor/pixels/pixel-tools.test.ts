import {describe, expect, it} from 'vitest';
import {applyDither, applyCameraRaw, createDefaultCameraRawSettings} from './camera-raw';
import {applyGradient, boxBlur, colorRangeSelection, contentAwareFill, createPixelBuffer, eraseBrush, featherSelection, magicWandSelection, paintBrush, selectSubject, selectionToMask, spotHealing} from './pixel-tools';

const solid = (color: [number, number, number, number], width = 8, height = 8) => createPixelBuffer(width, height, color);

describe('compositor stage 10 pixel tools', () => {
	it('keeps brush and eraser immutable and respects alpha', () => {
		const source = solid([0, 0, 0, 0]);
		const painted = paintBrush(source, [{x: 4, y: 4}], {size: 4, hardness: 1, opacity: 1, color: [255, 0, 0, 255]});
		expect(source.data[4 * 8 * 4 + 4 * 4 + 3]).toBe(0);
		expect(painted.data[4 * 8 * 4 + 4 * 4 + 3]).toBe(255);
		const erased = eraseBrush(painted, [{x: 4, y: 4}], {size: 2, hardness: 1, opacity: 1});
		expect(erased.data[4 * 8 * 4 + 4 * 4 + 3]).toBe(0);
	});
	it('supports blur, gradient, healing and selection to mask', () => {
		const source = solid([0, 0, 0, 255], 4, 4);
		source.data[0] = 255;
		const blurred = boxBlur(source, 1);
		expect(blurred.data[0]).toBeLessThan(255);
		const gradient = applyGradient(source, {start: [0, 0, 0, 255], end: [255, 255, 255, 255], angle: 0});
		expect(gradient.data[0]).not.toBe(gradient.data[12]);
		const healed = spotHealing(source, [{x: 1, y: 1}], {size: 2, opacity: 1});
		expect(healed.data.length).toBe(source.data.length);
		const selection = magicWandSelection(source, {x: 1, y: 1}, 10);
		expect(selectionToMask(selection).data.length).toBe(source.data.length);
	});
	it('offers color range, subject and content-aware fill fallbacks', () => {
		const source = solid([255, 0, 0, 255], 5, 5);
		const range = colorRangeSelection(source, [255, 0, 0], 1);
		const subject = selectSubject(source);
		const filled = contentAwareFill(source, featherSelection(subject, 1));
		expect(range.alpha.every((value) => value === 255)).toBe(true);
		expect(subject.alpha.some(Boolean)).toBe(true);
		expect(filled.data.length).toBe(source.data.length);
	});
	it('camera raw is identity by default and applies light/dither controls', () => {
		const source = solid([120, 120, 120, 255], 3, 3);
		const defaults = createDefaultCameraRawSettings();
		expect(applyCameraRaw(source, defaults).data).toEqual(source.data);
		const graded = applyCameraRaw(source, {...defaults, exposure: 1});
		expect(graded.data[0]).toBeGreaterThan(source.data[0]!);
		const dithered = applyDither(source, {...defaults.dither, enabled: true, levels: 2, style: 'bayer'}, false);
		expect(new Set(dithered.data.filter((_, index) => index % 4 !== 3)).size).toBeLessThanOrEqual(2);
	});
});
