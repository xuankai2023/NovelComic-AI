import {describe, expect, it} from 'vitest';
import {layoutSubtitle} from './layout-subtitle';

describe('layoutSubtitle', () => {
	it('wraps visible subtitles inside the canvas safe area', () => {
		const result = layoutSubtitle(
			{
				id: 'line-1',
				text: '这是一个测试字幕',
				from: 10,
				durationInFrames: 20,
			},
			15,
			{
				canvasWidth: 1080,
				canvasHeight: 1920,
				fontSize: 64,
				maxCharactersPerLine: 4,
			},
		);

		expect(result.visible).toBe(true);
		expect(result.lines).toEqual(['这是一个', '测试字幕']);
		expect(result.x).toBeGreaterThanOrEqual(0);
		expect(result.y).toBeGreaterThan(0);
	});

	it('hides subtitles outside their time range', () => {
		const result = layoutSubtitle(
			{id: 'line-1', text: 'test', from: 10, durationInFrames: 20},
			30,
			{canvasWidth: 100, canvasHeight: 100, fontSize: 10},
		);
		expect(result.visible).toBe(false);
	});
});
