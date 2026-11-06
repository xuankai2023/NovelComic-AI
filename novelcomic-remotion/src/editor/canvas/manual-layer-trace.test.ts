import {describe, expect, it} from 'vitest';
import {
	addTracePoint,
	canClosePolygon,
	clampPointToCanvas,
	getTraceBounds,
	getTracePolygonArea,
	isNearPoint,
	moveTracePoint,
	removeTracePoint,
	validateTracePolygon,
} from './manual-layer-trace';

const canvas = {width: 200, height: 100};

describe('manual layer tracing helpers', () => {
	it('clamps points to the source canvas bounds', () => {
		expect(clampPointToCanvas({x: -12, y: 140}, canvas)).toEqual({
			x: 0,
			y: 100,
		});
		expect(clampPointToCanvas({x: 260, y: -9}, canvas)).toEqual({
			x: 200,
			y: 0,
		});
	});

	it('adds clamped points without mutating the previous array', () => {
		const points = [{x: 10, y: 10}];
		const next = addTracePoint(points, {x: 250, y: 50}, canvas);

		expect(next).toEqual([
			{x: 10, y: 10},
			{x: 200, y: 50},
		]);
		expect(points).toEqual([{x: 10, y: 10}]);
	});

	it('detects when a candidate point can close a polygon', () => {
		const points = [
			{x: 20, y: 20},
			{x: 120, y: 20},
			{x: 80, y: 80},
		];

		expect(isNearPoint(points[0]!, {x: 25, y: 25}, 8)).toBe(true);
		expect(canClosePolygon(points, {x: 25, y: 25}, 8)).toBe(true);
		expect(canClosePolygon(points.slice(0, 2), {x: 25, y: 25}, 8)).toBe(false);
		expect(canClosePolygon(points, {x: 60, y: 60}, 8)).toBe(false);
	});

	it('moves and removes points immutably', () => {
		const points = [
			{x: 10, y: 10},
			{x: 60, y: 10},
			{x: 60, y: 60},
		];

		const moved = moveTracePoint(points, 1, {x: 220, y: -10}, canvas);
		expect(moved).toEqual([
			{x: 10, y: 10},
			{x: 200, y: 0},
			{x: 60, y: 60},
		]);
		expect(points[1]).toEqual({x: 60, y: 10});

		expect(removeTracePoint(moved, 1)).toEqual([
			{x: 10, y: 10},
			{x: 60, y: 60},
		]);
		expect(moveTracePoint(points, 99, {x: 0, y: 0}, canvas)).toEqual(points);
		expect(removeTracePoint(points, 99)).toEqual(points);
	});

	it('computes polygon bounds and area', () => {
		const points = [
			{x: 30, y: 20},
			{x: 130, y: 40},
			{x: 100, y: 90},
			{x: 20, y: 70},
		];

		expect(getTraceBounds(points)).toEqual({
			x: 20,
			y: 20,
			width: 110,
			height: 70,
		});
		expect(getTracePolygonArea(points)).toBe(4900);
	});

	it('validates usable polygons and rejects invalid geometry', () => {
		expect(
			validateTracePolygon(
				[
					{x: 10, y: 10},
					{x: 100, y: 10},
					{x: 60, y: 70},
				],
				canvas,
			),
		).toEqual({
			valid: true,
			bounds: {x: 10, y: 10, width: 90, height: 60},
		});

		expect(validateTracePolygon([{x: 10, y: 10}], canvas)).toMatchObject({
			valid: false,
		});
		expect(
			validateTracePolygon(
				[
					{x: 10, y: 10},
					{x: 40, y: 40},
					{x: 70, y: 70},
				],
				canvas,
			),
		).toMatchObject({valid: false});
		expect(
			validateTracePolygon(
				[
					{x: 10, y: 10},
					{x: 220, y: 10},
					{x: 60, y: 70},
				],
				canvas,
			),
		).toMatchObject({valid: false});
	});
});
