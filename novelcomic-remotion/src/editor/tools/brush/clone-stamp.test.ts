import {beforeEach, describe, expect, it} from 'vitest';
import {activateBrushTip, getBrushToolSettings, resetBrushToolSettings, updateBrushToolSettings} from './brush-settings';
import {
	cloneSamplePoint,
	cloneStrokeOffset,
	getCloneSettings,
	resetCloneSettings,
	setCloneAligned,
	setCloneOffset,
	setCloneSource,
} from './clone-stamp';

describe('clone stamp settings', () => {
	beforeEach(() => {
		resetBrushToolSettings();
		resetCloneSettings();
	});

	it('keeps an aligned offset, restarts when alignment is off, and drops it for a new source', () => {
		setCloneSource({x: 15, y: 20});
		expect(cloneStrokeOffset({x: 60, y: 20})).toEqual({x: -45, y: 0});
		expect(cloneSamplePoint({x: 60, y: 20}, false)).toEqual({x: 15, y: 20});
		setCloneOffset({x: -45, y: 0});
		expect(cloneStrokeOffset({x: 66, y: 20})).toEqual({x: -45, y: 0});
		expect(cloneSamplePoint({x: 66, y: 20}, false)).toEqual({x: 21, y: 20});

		setCloneAligned(false);
		expect(cloneStrokeOffset({x: 50, y: 10})).toEqual({x: -35, y: 10});
		expect(cloneSamplePoint({x: 50, y: 10}, false)).toEqual({x: 15, y: 20});
		expect(cloneSamplePoint({x: 50, y: 10}, true)).toEqual({x: 5, y: 10});

		setCloneSource({x: 0, y: 0});
		expect(getCloneSettings().offset).toBeNull();
		expect(cloneStrokeOffset({x: -1.5, y: 1.5})).toEqual({x: 2, y: -2});
		setCloneSource({x: Number.NaN, y: 1});
		expect(getCloneSettings().source).toEqual({x: 0, y: 0});
	});

	it('keeps Clone Stamp’s soft tip apart from the brush', () => {
		updateBrushToolSettings({diameter: 30, smoothing: 12});
		expect(getBrushToolSettings().hardness).toBe(1);
		activateBrushTip('clone-stamp');
		expect(getBrushToolSettings().hardness).toBe(0);
		expect(getBrushToolSettings().diameter).toBe(40);
		expect(getBrushToolSettings().smoothing).toBe(12);
		updateBrushToolSettings({hardness: 0.5});
		activateBrushTip('healing');
		expect(getBrushToolSettings().hardness).toBe(1);
		expect(getBrushToolSettings().diameter).toBe(30);
		activateBrushTip('clone-stamp');
		expect(getBrushToolSettings().hardness).toBe(0.5);
		expect(getBrushToolSettings().diameter).toBe(40);
		expect(getBrushToolSettings().smoothing).toBe(12);
	});
});
