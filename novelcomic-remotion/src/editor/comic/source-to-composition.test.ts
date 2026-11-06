import {describe, expect, it} from 'vitest';
import {
	getSourceToCompositionScale,
	sourceBoundsToComposition,
	sourcePointToComposition,
	sourcePolygonToComposition,
} from './source-to-composition';

describe('source to composition geometry', () => {
	it('maps points and bounds with the same coordinate protocol', () => {
		const sourceCanvas = {width: 1000, height: 2000};
		const compositionCanvas = {width: 500, height: 1000};

		expect(
			sourcePointToComposition(
				{x: 120, y: 240},
				sourceCanvas,
				compositionCanvas,
			),
		).toEqual({x: 60, y: 120});
		expect(
			sourceBoundsToComposition(
				{x: 120, y: 240, width: 300, height: 420},
				sourceCanvas,
				compositionCanvas,
			),
		).toEqual({x: 60, y: 120, width: 150, height: 210});
		expect(
			sourcePolygonToComposition(
				[
					{x: 120, y: 240},
					{x: 420, y: 240},
					{x: 420, y: 660},
				],
				sourceCanvas,
				compositionCanvas,
			),
		).toEqual([
			{x: 60, y: 120},
			{x: 210, y: 120},
			{x: 210, y: 330},
		]);
	});

	it('keeps independent x and y scaling when canvas aspect ratios differ', () => {
		expect(
			getSourceToCompositionScale(
				{width: 1000, height: 2000},
				{width: 1920, height: 1080},
			),
		).toEqual({x: 1.92, y: 0.54});

		expect(
			sourceBoundsToComposition(
				{x: 100, y: 200, width: 300, height: 400},
				{width: 1000, height: 2000},
				{width: 1920, height: 1080},
			),
		).toEqual({x: 192, y: 108, width: 576, height: 216});
	});

	it('rejects invalid canvases and non-finite geometry', () => {
		expect(() => {
			getSourceToCompositionScale(
				{width: 0, height: 100},
				{width: 100, height: 100},
			);
		}).toThrow(/sourceCanvas/);

		expect(() => {
			sourcePointToComposition(
				{x: Number.NaN, y: 10},
				{width: 100, height: 100},
				{width: 100, height: 100},
			);
		}).toThrow(/finite coordinates/);

		expect(() => {
			sourceBoundsToComposition(
				{x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10},
				{width: 100, height: 100},
				{width: 100, height: 100},
			);
		}).toThrow(/finite geometry/);
	});
});
