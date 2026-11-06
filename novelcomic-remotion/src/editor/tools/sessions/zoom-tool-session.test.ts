import {describe, expect, it} from 'vitest';
import {createEmptyDocument} from '../../document/defaults';
import {ViewportStore} from '../../viewport/viewport-store';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {scrubZoom, ZoomToolSession} from './zoom-tool-session';

const modifiers = (patch: Partial<ToolModifiers> = {}): ToolModifiers => ({
	shift: false,
	alt: false,
	meta: false,
	control: false,
	space: false,
	...patch,
});

const harness = (zoom = 1) => {
	const commands: string[] = [];
	const store = new ViewportStore();
	store.setViewportSize(1000, 800, 2);
	store.setDocumentSize(500, 400);
	store.setTransform({zoom, panX: 30, panY: -16});
	const context = {
		document: createEmptyDocument({width: 500, height: 400}),
		selectedLayerIds: [],
		activeLayerId: null,
		get viewport() {
			return store.getSnapshot();
		},
		setSelection: () => undefined,
		clearSelection: () => undefined,
		commitSelection: () => undefined,
		dispatch: () => {
			commands.push('dispatch');
		},
		dispatchCommands: () => {
			commands.push('dispatchCommands');
		},
		setViewportPan: () => {
			commands.push('pan');
		},
		setViewportZoom: (point: {x: number; y: number}, next: number) => store.zoomAt(point, next),
		getViewport: () => store.getSnapshot(),
	} satisfies ToolSessionContext;
	const session = new ZoomToolSession(context);
	const pointer = (
		x: number,
		y: number,
		keys: Partial<ToolModifiers> = {},
		buttons = 1,
	): ToolPointerEvent => ({
		pointerId: 1,
		pointerType: 'mouse',
		buttons,
		pressure: 1,
		clientPoint: {x, y},
		viewportPoint: {x, y},
		documentPoint: {x, y},
		modifiers: modifiers(keys),
	});
	return {session, store, commands, pointer};
};

describe('zoom tool', () => {
	it('waits until release to step ×2 about the press', () => {
		const {session, store, commands, pointer} = harness();
		const anchor = {x: 180, y: 240};
		const before = store.controller.screenToDocument(anchor);
		session.pointerDown(pointer(anchor.x, anchor.y));
		expect(store.getSnapshot().transform.zoom).toBe(1);
		session.pointerUp(pointer(anchor.x, anchor.y, {}, 0));
		expect(store.getSnapshot().transform.zoom).toBe(2);
		const after = store.controller.screenToDocument(anchor);
		expect(after.x).toBeCloseTo(before.x, 5);
		expect(after.y).toBeCloseTo(before.y, 5);
		expect(session.status).toBe('idle');
		session.pointerCancel('lostpointercapture');
		expect(session.status).toBe('idle');
		expect(store.getSnapshot().transform.zoom).toBe(2);
		expect(commands).toEqual([]);
	});

	it('reads Option on release, so a click zooms out by half', () => {
		const {session, store, pointer} = harness(4);
		session.pointerDown(pointer(20, 20));
		session.pointerUp(pointer(21, 20, {alt: true}, 0));
		expect(store.getSnapshot().transform.zoom).toBe(2);
		expect(session.getOverlayState()?.canvasCursor).toBe('zoom-out');
	});

	it('scrubs horizontally about the press and does not take another step on release', () => {
		const {session, store, pointer} = harness(1);
		const anchor = {x: 220, y: 160};
		const before = store.controller.screenToDocument(anchor);
		session.pointerDown(pointer(anchor.x, anchor.y));
		session.pointerMove(pointer(anchor.x + 2, anchor.y + 40));
		expect(store.getSnapshot().transform.zoom).toBe(1);
		session.pointerMove(pointer(anchor.x + 100, anchor.y + 40));
		expect(store.getSnapshot().transform.zoom).toBeCloseTo(scrubZoom(1, 100), 6);
		session.pointerMove(pointer(anchor.x, anchor.y));
		expect(store.getSnapshot().transform.zoom).toBeCloseTo(1, 6);
		session.pointerUp(pointer(anchor.x, anchor.y, {}, 0));
		expect(store.getSnapshot().transform.zoom).toBeCloseTo(1, 6);
		const after = store.controller.screenToDocument(anchor);
		expect(after.x).toBeCloseTo(before.x, 5);
		expect(after.y).toBeCloseTo(before.y, 5);
	});

	it('zooms out to the left and keeps the original zoom as the base', () => {
		const {session, store, pointer} = harness(2);
		session.pointerDown(pointer(50, 50));
		session.pointerMove(pointer(50 - 100, 80));
		expect(store.getSnapshot().transform.zoom).toBeCloseTo(1, 6);
		session.pointerMove(pointer(50 - 200, 80));
		expect(store.getSnapshot().transform.zoom).toBeCloseTo(scrubZoom(2, -200), 6);
	});

	it('switches the cursor with Option before a press', () => {
		const {session} = harness();
		expect(session.getOverlayState()?.canvasCursor).toBe('zoom-in');
		expect(session.keyDown({key: 'Alt', modifiers: modifiers({alt: true})})).toBe(true);
		expect(session.getOverlayState()?.canvasCursor).toBe('zoom-out');
		expect(session.keyUp({key: 'Alt', modifiers: modifiers()})).toBe(true);
		expect(session.getOverlayState()?.canvasCursor).toBe('zoom-in');
	});

	it('does not step-zoom when the press is cancelled', () => {
		const {session, store, commands, pointer} = harness();
		session.pointerDown(pointer(10, 10));
		session.pointerCancel('pointercancel');
		expect(store.getSnapshot().transform.zoom).toBe(1);
		expect(commands).toEqual([]);
		session.pointerUp(pointer(10, 10, {}, 0));
		expect(store.getSnapshot().transform.zoom).toBe(1);
	});
});
