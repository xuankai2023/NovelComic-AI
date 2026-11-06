import {describe, expect, it} from 'vitest';
import {evaluatePropertyGraph} from './evaluate-property';
import type {NumericKeyframe, PropertyGraphV1, PropertySet} from './types';
import {propertySetId} from './types';

const owner = {kind: 'item', id: 'item-1'} as const;

const graphWith = (
	keyframes: NumericKeyframe[],
	patch: Partial<PropertySet> = {},
): PropertyGraphV1 => {
	const set: PropertySet = {
		owner,
		loop: 'none',
		properties: {x: {baseValue: 0, keyframes}},
		...patch,
	};
	return {version: 1, sets: {[propertySetId(owner)]: set}};
};

const sample = (graph: PropertyGraphV1, frame: number, durationInFrames = 20) =>
	evaluatePropertyGraph({graph, owner, frame, durationInFrames}).x;

describe('evaluatePropertyGraph', () => {
	it.each([
		['linear', 5],
		['ease-in', 1.25],
		['ease-out', 8.75],
		['ease-in-out', 5],
	] as const)('supports %s easing', (easing, expected) => {
		const graph = graphWith([
			{frame: 0, value: 0, easing: 'linear'},
			{frame: 10, value: 10, easing},
		]);
		expect(sample(graph, 5)).toBeCloseTo(expected);
	});

	it('supports hold, repeat, ping-pong and clamped boundary frames', () => {
		const held = graphWith([
			{frame: 0, value: 2, easing: 'linear', hold: true},
			{frame: 4, value: 8, easing: 'linear'},
		]);
		expect(sample(held, 3, 5)).toBe(2);
		expect(sample(held, 99, 5)).toBe(8);

		const repeat = graphWith(
			[
				{frame: 0, value: 0, easing: 'linear'},
				{frame: 2, value: 2, easing: 'linear'},
			],
			{loop: 'repeat', loopStartFrame: 0, loopEndFrame: 2},
		);
		expect(sample(repeat, 4, 10)).toBe(1);

		const pingPong = graphWith(
			[
				{frame: 0, value: 0, easing: 'linear'},
				{frame: 2, value: 2, easing: 'linear'},
			],
			{loop: 'ping-pong', loopStartFrame: 0, loopEndFrame: 2},
		);
		expect(sample(pingPong, 3, 10)).toBe(1);
	});

	it('blocks duplicate and invalid property data', () => {
		const duplicate = graphWith([
			{frame: 1, value: 1, easing: 'linear'},
			{frame: 1, value: 2, easing: 'linear'},
		]);
		expect(() => sample(duplicate, 1)).toThrow(/duplicate frame/);

		const set = duplicate.sets[propertySetId(owner)]!;
		set.properties = {opacity: {baseValue: 2, keyframes: []}};
		expect(() => sample(duplicate, 1)).toThrow(/opacity must be between/);

		set.properties = {skew: {baseValue: 0, keyframes: []}};
		expect(() => sample(duplicate, 1)).toThrow(/not supported/);
	});
});
