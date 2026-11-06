import {describe, expect, it} from 'vitest';
import {createEmptyDocument, createPixelLayer} from '../../document/defaults';
import {createPixelBuffer} from '../../pixels/pixel-tools';
import {BrushStroke, brushFalloff, identityBrushSpace, makeBrushSpace} from './brush-stroke';

const alpha = (stroke: BrushStroke, x: number, y: number) => stroke.pixels.data[(y * stroke.pixels.width + x) * 4 + 3];

describe('brush stroke', () => {
	it('matches the Compositor tip falloff', () => {
		expect(brushFalloff(0, 10, 0)).toBe(1);
		expect(brushFalloff(10, 10, 0.5)).toBe(0);
		expect(brushFalloff(4, 10, 1)).toBe(1);
		expect(brushFalloff(11, 10, 1)).toBe(0);
	});

	it('paints a hard disc and leaves the rest untouched', () => {
		const stroke = new BrushStroke(
			createPixelBuffer(8, 8),
			{diameter: 2, hardness: 1, opacity: 1, erasing: false, color: {r: 0, g: 0, b: 0}},
			identityBrushSpace(8, 8),
		);
		stroke.append({x: 2.5, y: 2.5});
		stroke.flush();
		expect(alpha(stroke, 2, 2)).toBe(255);
		expect(stroke.pixels.data[(2 * 8 + 2) * 4]).toBe(0);
		expect(alpha(stroke, 0, 0)).toBe(0);
		expect(alpha(stroke, 6, 6)).toBe(0);
	});

	it('caps overlapping dabs at the stroke opacity', () => {
		const stroke = new BrushStroke(
			createPixelBuffer(30, 30),
			{diameter: 20, hardness: 1, opacity: 0.5, erasing: false, color: {r: 0, g: 0, b: 0}},
			identityBrushSpace(30, 30),
		);
		stroke.append({x: 10, y: 15});
		stroke.append({x: 20, y: 15});
		stroke.flush();
		expect(alpha(stroke, 15, 15)).toBe(128);
	});

	it('erases alpha without painting the foreground color', () => {
		const source = createPixelBuffer(8, 8, [10, 20, 30, 255]);
		const stroke = new BrushStroke(
			source,
			{diameter: 8, hardness: 1, opacity: 1, erasing: true, color: {r: 255, g: 0, b: 0}},
			identityBrushSpace(8, 8),
		);
		stroke.append({x: 4, y: 4});
		stroke.flush();
		const offset = (4 * 8 + 4) * 4;
		expect(stroke.pixels.data[offset]).toBe(10);
		expect(stroke.pixels.data[offset + 3]).toBeLessThan(255);
	});

	it('copies sampled pixels through the tip and leaves clear samples untouched', () => {
		const source = createPixelBuffer(8, 8, [10, 20, 30, 255]);
		const copied = new BrushStroke(
			source,
			{diameter: 2, hardness: 1, opacity: 1, erasing: false, color: {r: 255, g: 0, b: 0}},
			identityBrushSpace(8, 8),
		);
		copied.useClone(() => ({r: 0, g: 255, b: 0, a: 255}));
		copied.append({x: 2.5, y: 2.5});
		copied.flush();
		expect(Array.from(copied.pixels.data.subarray((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4))).toEqual([0, 255, 0, 255]);
		expect(Array.from(copied.pixels.data.subarray(0, 4))).toEqual([10, 20, 30, 255]);

		const clear = new BrushStroke(
			source,
			{diameter: 8, hardness: 1, opacity: 1, erasing: false, color: {r: 255, g: 0, b: 0}},
			identityBrushSpace(8, 8),
		);
		clear.useClone(() => ({r: 0, g: 0, b: 0, a: 0}));
		clear.append({x: 4, y: 4});
		clear.flush();
		expect(Array.from(clear.pixels.data.subarray((4 * 8 + 4) * 4, (4 * 8 + 4) * 4 + 4))).toEqual([10, 20, 30, 255]);
	});

	it('follows a rotated layer instead of the document grid', () => {
		const document = createEmptyDocument({width: 8, height: 8, projectId: 'p'});
		const layer = createPixelLayer('asset', 'Rotated', 8, 8);
		layer.id = 'layer';
		layer.transform.rotation = 90;
		document.layers[layer.id] = layer;
		document.rootLayerIds = [layer.id];
		const space = makeBrushSpace(document, layer, 8, 8);
		expect(space).not.toBeNull();
		const stroke = new BrushStroke(
			createPixelBuffer(8, 8),
			{diameter: 4, hardness: 1, opacity: 1, erasing: false, color: {r: 255, g: 0, b: 0}},
			space!,
		);
		stroke.append({x: 4, y: 4});
		stroke.flush();
		expect(alpha(stroke, 4, 4)).toBeGreaterThan(0);
		expect(alpha(stroke, 0, 0)).toBe(0);
	});
});
