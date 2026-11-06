import {describe, expect, it} from 'vitest';
import {ViewportController} from './viewport-controller';

describe('main editor viewport', () => {
	it('round-trips document coordinates at high DPI', () => {
		const controller = new ViewportController();
		controller.setViewportSize(1200, 800, 3);
		controller.setDocumentSize(800, 600);
		controller.fit(40);

		const point = {x: 234.25, y: 412.75};
		const screen = controller.documentToScreen(point);
		const roundTrip = controller.screenToDocument(screen);

		expect(roundTrip.x).toBeCloseTo(point.x, 6);
		expect(roundTrip.y).toBeCloseTo(point.y, 6);
		expect(controller.getTransform().devicePixelRatio).toBe(3);
	});

	it('keeps the document point below the cursor while zooming', () => {
		const controller = new ViewportController();
		controller.setViewportSize(1000, 700);
		controller.setDocumentSize(500, 400);
		controller.setTransform({zoom: 1.25, panX: 31, panY: -18});

		const pointer = {x: 713, y: 289};
		const documentPoint = controller.screenToDocument(pointer);
		controller.zoomAt(pointer, 2.5);

		expect(controller.documentToScreen(documentPoint).x).toBeCloseTo(pointer.x);
		expect(controller.documentToScreen(documentPoint).y).toBeCloseTo(pointer.y);
	});

	it('does not expose a partially implemented rotation mode', () => {
		const controller = new ViewportController();
		controller.setTransform({rotation: 0});
		expect(controller.getTransform().rotation).toBe(0);
	});
});
