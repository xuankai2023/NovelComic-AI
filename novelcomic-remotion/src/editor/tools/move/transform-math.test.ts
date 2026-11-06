import {describe, expect, it} from 'vitest';
import {createEmptyDocument, createShapeLayer} from '../../document/defaults';
import {layerToDocument} from '../coordinates';
import {
	dragUpdated,
	hitOverlay,
	overlayFromCorners,
	placedCenter,
	placedCorners,
	placedContains,
	placedPoint,
	snapPlacedMove,
	toPlaced,
	transformPressLayer,
} from './transform-math';

const transform = (
	patch: Partial<ReturnType<typeof toPlaced>> & {width?: number; height?: number} = {},
) =>
	toPlaced({
		originX: patch.originX ?? 0,
		originY: patch.originY ?? 0,
		width: patch.width ?? patch.contentWidth ?? 100,
		height: patch.height ?? patch.contentHeight ?? 100,
		rotation: patch.rotation ?? 0,
		scaleX: 1,
		scaleY: 1,
		sampling: 'smooth',
	});

describe('move transform math', () => {
	it('maps the box center and keeps flips inside the rectangle', () => {
		const placed = transform({originX: 10, originY: 20, width: 100, height: 40});
		expect(placedPoint(placed, {x: 0, y: 0})).toEqual({x: 10, y: 20});
		expect(placedContains(placed, {x: 9, y: 20})).toBe(false);
		expect(placedContains(placed, {x: 60, y: 40})).toBe(true);
		const turned = {...placed, rotation: 90};
		expect(placedPoint(turned, {x: 0, y: 0}).x).toBeCloseTo(80);
		expect(placedPoint(turned, {x: 0, y: 0}).y).toBeCloseTo(-10);
	});

	it('matches the layer matrix at 0° and 90°', () => {
		const document = createEmptyDocument({width: 200, height: 200});
		const upright = createShapeLayer('rectangle', 'Upright', 100, 40);
		upright.transform = {...upright.transform, originX: 12, originY: 8};
		document.layers[upright.id] = upright;
		expect(layerToDocument({x: 0, y: 0}, document, upright.id)).toEqual({x: 12, y: 8});
		expect(layerToDocument({x: 100, y: 40}, document, upright.id)).toEqual({
			x: 112,
			y: 48,
		});
		const turned = createShapeLayer('rectangle', 'Turned', 100, 100);
		turned.transform = {...turned.transform, rotation: 90};
		document.layers[turned.id] = turned;
		expect(layerToDocument({x: 0, y: 0}, document, turned.id)?.x).toBeCloseTo(100);
		expect(layerToDocument({x: 0, y: 0}, document, turned.id)?.y).toBeCloseTo(0);
		expect(layerToDocument({x: 100, y: 100}, document, turned.id)?.x).toBeCloseTo(0);
		expect(layerToDocument({x: 100, y: 100}, document, turned.id)?.y).toBeCloseTo(100);
	});

	it('moves from a press outside the layer box', () => {
		const next = dragUpdated(
			{
				original: transform({originX: 150, originY: 100}),
				start: {x: 0, y: 0},
				mode: {kind: 'move'},
				originalCorners: null,
			},
			{x: 20, y: 10},
			true,
			false,
			false,
		);
		expect(next.originX).toBe(170);
		expect(next.originY).toBe(110);
	});

	it('keeps the opposite edge while resizing and rotates around the center', () => {
		const resized = dragUpdated(
			{
				original: transform(),
				start: {x: 100, y: 50},
				mode: {kind: 'resize', index: 3},
				originalCorners: null,
			},
			{x: 140, y: 50},
			false,
			false,
			false,
		);
		expect(resized.originX).toBeCloseTo(0);
		expect(resized.originY).toBeCloseTo(0);
		expect(resized.placedWidth).toBeCloseTo(140);
		expect(resized.placedHeight).toBeCloseTo(100);
		const original = transform({originX: 10, originY: 20, width: 100, height: 40});
		const center = placedCenter(original);
		const rotated = dragUpdated(
			{
				original,
				start: {x: center.x, y: center.y - 100},
				mode: {kind: 'rotate'},
				originalCorners: null,
			},
			{x: center.x + 100, y: center.y},
			true,
			false,
			false,
		);
		expect(rotated.rotation).toBeCloseTo(90);
		expect(placedCenter(rotated).x).toBeCloseTo(center.x);
		expect(placedCenter(rotated).y).toBeCloseTo(center.y);
	});

	it('snaps a moved edge to the canvas within 10 screen pixels', () => {
		const document = createEmptyDocument({width: 400, height: 300});
		const layer = createShapeLayer('rectangle', 'Layer', 100, 100);
		document.layers[layer.id] = layer;
		document.rootLayerIds = [layer.id];
		const snapped = snapPlacedMove(
			document,
			transform({originX: 6, originY: 80}),
			[layer.id],
			1,
		);
		expect(snapped.placed.originX).toBe(0);
		expect(snapped.placed.originY).toBe(80);
	});

	it('hits a rotated edge instead of the axis-aligned bounds', () => {
		const placed = {...transform({width: 200, height: 80}), rotation: 37};
		const corners = placedCorners(placed);
		const geometry = overlayFromCorners(corners, 1, true);
		const start = corners[0];
		const end = corners[1];
		const dx = end.x - start.x;
		const dy = end.y - start.y;
		const length = Math.hypot(dx, dy);
		const point = {
			x: start.x + dx * 0.75 + (-dy / length) * 4,
			y: start.y + dy * 0.75 + (dx / length) * 4,
		};
		expect(hitOverlay(geometry, point, 1)).toEqual({kind: 'resize', index: 1});
		const outside = {x: -30, y: -30};
		expect(placedContains(placed, outside)).toBe(false);
		expect(hitOverlay(geometry, outside, 1)).toBeNull();
	});

	it('lets Command invert auto-select without changing the stored flag', () => {
		const document = createEmptyDocument({width: 400, height: 300});
		const blue = createShapeLayer('rectangle', 'Blue', 400, 300);
		const red = createShapeLayer('rectangle', 'Red', 100, 100);
		red.transform = {...red.transform, originX: 150, originY: 100};
		red.order = 1;
		document.layers[blue.id] = blue;
		document.layers[red.id] = red;
		document.rootLayerIds = [blue.id, red.id];
		const point = {x: 200, y: 150};
		expect(
			transformPressLayer({
				document,
				point,
				activeLayerId: blue.id,
				selectedLayerIds: [blue.id],
				autoSelect: false,
				command: true,
				shift: false,
			})?.id,
		).toBe(red.id);
		expect(
			transformPressLayer({
				document,
				point,
				activeLayerId: blue.id,
				selectedLayerIds: [blue.id],
				autoSelect: true,
				command: false,
				shift: false,
			})?.id,
		).toBe(red.id);
		expect(
			transformPressLayer({
				document,
				point,
				activeLayerId: blue.id,
				selectedLayerIds: [blue.id],
				autoSelect: true,
				command: true,
				shift: false,
			})?.id,
		).toBe(blue.id);
	});
});
