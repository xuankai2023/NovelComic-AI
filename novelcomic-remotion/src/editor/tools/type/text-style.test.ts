import {afterEach, describe, expect, it} from 'vitest';
import {placedPoint, toPlaced} from '../move/transform-math';
import {
	boxIsValid,
	colorAt,
	defaultTextStyle,
	fontFaceWarning,
	layerNameForText,
	layoutText,
	pinTextOrigin,
	pointTextOrigin,
	replaceTextContent,
	setTextColor,
	setTextMeasurer,
	textTooLargeMessage,
} from './text-style';

describe('text style', () => {
	afterEach(() => setTextMeasurer(null));

	it('paints a full selection as the base color and a partial selection as a run', () => {
		const style = {...defaultTextStyle(), content: 'abcd'};
		const all = setTextColor(style, {r: 255, g: 0, b: 0}, 0, 4);
		expect(all.color).toEqual({r: 255, g: 0, b: 0});
		expect(all.runs).toEqual([]);
		const partial = setTextColor(style, {r: 255, g: 0, b: 0}, 1, 3);
		expect(partial.color).toEqual({r: 0, g: 0, b: 0});
		expect(colorAt(partial, 0)).toEqual({r: 0, g: 0, b: 0});
		expect(colorAt(partial, 1)).toEqual({r: 255, g: 0, b: 0});
		expect(colorAt(partial, 2)).toEqual({r: 255, g: 0, b: 0});
		expect(colorAt(partial, 3)).toEqual({r: 0, g: 0, b: 0});
	});

	it('gives inserted letters the face and color of the letter before them', () => {
		const colored = setTextColor({...defaultTextStyle(), content: 'abcd'}, {r: 255, g: 0, b: 0}, 1, 3);
		const next = replaceTextContent(colored, 'aXcd');
		expect(next?.content).toBe('aXcd');
		expect(colorAt(next!, 1)).toEqual({r: 0, g: 0, b: 0});
		expect(colorAt(next!, 2)).toEqual({r: 255, g: 0, b: 0});
	});

	it('names a layer from collapsed text, and empty text stays Text', () => {
		expect(layerNameForText('  hello   world  ')).toBe('hello world');
		expect(layerNameForText('   ')).toBe('Text');
		expect(layerNameForText('a'.repeat(50))).toHaveLength(40);
	});

	it('places the first baseline on the click and keeps a minimum box', () => {
		const placed = pointTextOrigin({x: 100, y: 100}, {...defaultTextStyle(), content: ''});
		expect(placed.originX).toBe(88);
		expect(placed.originY).toBeCloseTo(16);
		expect(placed.width).toBe(32);
		expect(placed.height).toBe(111);
	});

	it('wraps a paragraph on the measured width', () => {
		setTextMeasurer({
			width: (text) => text.length * 10,
			descent: (_family, size) => size * 0.2,
		});
		const layout = layoutText({...defaultTextStyle(), content: 'abcd', fontSize: 10, leading: 12}, {width: 44, height: 80}, true);
		expect(layout.lines.map((line) => line.text)).toEqual(['ab', 'cd']);
	});

	it('keeps the rotated top-left pinned when point text grows', () => {
		const before = {
			originX: 0,
			originY: 0,
			width: 10,
			height: 10,
			rotation: 90,
			scaleX: 1,
			scaleY: 1,
			sampling: 'smooth' as const,
		};
		const pinned = pinTextOrigin(before, {...before, width: 20});
		expect(pinned.originX).toBeCloseTo(-5);
		expect(pinned.originY).toBeCloseTo(5);
		const corner = placedPoint(toPlaced(pinned), {x: 0, y: 0});
		expect(corner.x).toBeCloseTo(10);
		expect(corner.y).toBeCloseTo(0);
	});

	it('rejects a box that is too small or past the pixel limit', () => {
		expect(boxIsValid({width: 10, height: 20})).toBe(false);
		expect(boxIsValid({width: 32769, height: 16})).toBe(false);
		expect(boxIsValid({width: 20000, height: 10001})).toBe(false);
		expect(textTooLargeMessage()).toContain('32768');
	});

	it('warns only when the face is not one we can draw', () => {
		expect(fontFaceWarning('Helvetica')).toBeNull();
		expect(fontFaceWarning('Nope')).toContain('找不到字体');
	});
});
