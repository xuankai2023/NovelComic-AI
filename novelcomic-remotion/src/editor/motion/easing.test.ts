import {describe, expect, it} from 'vitest';
import {applyEasing} from './easing';
import {EASING_NAMES, type EasingName} from './types';

const samples = Array.from({length: 21}, (_, index) => index / 20);

describe('applyEasing', () => {
	it('clamps endpoints for every easing', () => {
		for (const name of EASING_NAMES) {
			expect(applyEasing(name, 0)).toBe(0);
			expect(applyEasing(name, 1)).toBe(1);
		}
	});

	it('places the midpoint on the expected side of linear', () => {
		expect(applyEasing('linear', 0.5)).toBe(0.5);
		expect(applyEasing('ease-in', 0.5)).toBeCloseTo(0.125);
		expect(applyEasing('ease-out', 0.5)).toBeCloseTo(0.875);
		expect(applyEasing('ease-in-out', 0.5)).toBeCloseTo(0.5);
		expect(applyEasing('ease-in', 0.5)).toBeLessThan(0.5);
		expect(applyEasing('ease-out', 0.5)).toBeGreaterThan(0.5);
	});

	it('stays monotonic from 0 to 1', () => {
		for (const name of EASING_NAMES) {
			let previous = -1;
			for (const sample of samples) {
				const value = applyEasing(name, sample);
				expect(value).toBeGreaterThanOrEqual(previous);
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(1);
				previous = value;
			}
		}
	});

	it('clamps illegal progress and unknown names', () => {
		expect(applyEasing('linear', -2)).toBe(0);
		expect(applyEasing('ease-out', 4)).toBe(1);
		expect(applyEasing('ease-in', Number.NaN)).toBe(0);
		expect(applyEasing('ease-in-out', Number.POSITIVE_INFINITY)).toBe(0);
		expect(applyEasing('ease-in-out', Number.NEGATIVE_INFINITY)).toBe(0);
		expect(applyEasing('spring' as EasingName, 0.5)).toBe(0.5);
		expect(applyEasing('spring' as EasingName, 2)).toBe(1);
	});
});
