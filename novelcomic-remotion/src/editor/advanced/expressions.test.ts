import {describe, expect, it} from 'vitest';
import {
	evaluateExpression,
	expressionValueAsNumber,
	parseExpression,
} from './expressions';

describe('safe expressions', () => {
	it('parses and evaluates deterministic transform expressions', () => {
		const parsed = parseExpression('value + sin(time * 2) * 4');
		expect(parsed.dependencies).toEqual(['time', 'value']);

		const first = evaluateExpression(
			parsed.ast,
			{time: 0.5, frame: 15, fps: 30, value: 10, seed: 7},
			10,
		);
		const second = evaluateExpression(
			parsed.ast,
			{time: 0.5, frame: 15, fps: 30, value: 10, seed: 7},
			10,
		);

		expect(first.usedFallback).toBe(false);
		expect(first.value).toBe(second.value);
		expect(expressionValueAsNumber(first.value, 0)).toBeCloseTo(
			10 + Math.sin(1) * 4,
		);
	});

	it('supports vectors and rejects unsafe identifiers', () => {
		const parsed = parseExpression('[value + 2, value - 2]');
		const result = evaluateExpression(
			parsed.ast,
			{time: 0, frame: 0, fps: 30, value: 5, seed: 1},
			0,
		);
		expect(result.value).toEqual([7, 3]);

		expect(() => parseExpression('globalThis.process.exit()')).toThrow(
			/Unknown expression identifier/,
		);
	});

	it('returns a fallback instead of throwing during evaluation', () => {
		const parsed = parseExpression('1 / 0');
		const result = evaluateExpression(
			parsed.ast,
			{time: 0, frame: 0, fps: 30, value: 4, seed: 1},
			4,
		);
		expect(result.usedFallback).toBe(false);
		expect(result.value).toBe(0);

		const invalidRuntime = parseExpression('clamp([1, 2], 0, 1)');
		const fallback = evaluateExpression(
			invalidRuntime.ast,
			{time: 0, frame: 0, fps: 30, value: 4, seed: 1},
			4,
		);
		expect(fallback.usedFallback).toBe(true);
		expect(fallback.value).toBe(4);
	});
});
