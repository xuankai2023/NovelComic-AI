import {describe, expect, it} from 'vitest';
import {createEmptyDocument} from '../../document/defaults';
import {ViewportStore} from '../../viewport/viewport-store';
import type {ToolModifiers, ToolPointerEvent, ToolSessionContext} from '../types';
import {HandToolSession} from './hand-tool-session';

const modifiers = (patch: Partial<ToolModifiers> = {}): ToolModifiers => ({
	shift: false,
	alt: false,
	meta: false,
	control: false,
	space: false,
	...patch,
});

const harness = () => {
	const commands: string[] = [];
	const store = new ViewportStore();
	store.setViewportSize(1000, 800, 1);
	store.setDocumentSize(400, 300);
	store.setTransform({zoom: 1.5, panX: 20, panY: -8});
	const context = {
		document: createEmptyDocument({width: 400, height: 300}),
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
		setViewportPan: (delta: {x: number; y: number}) => store.panBy(delta),
		setViewportZoom: () => {
			commands.push('zoom');
		},
		getViewport: () => store.getSnapshot(),
	} satisfies ToolSessionContext;
	const session = new HandToolSession(context);
	const pointer = (x: number, y: number, buttons = 1): ToolPointerEvent => ({
		pointerId: 1,
		pointerType: 'mouse',
		buttons,
		pressure: 1,
		clientPoint: {x: 0, y: 0},
		viewportPoint: {x, y},
		documentPoint: {x, y},
		modifiers: modifiers(),
	});
	return {session, store, commands, pointer};
};

describe('hand tool', () => {
	it('pans by the view delta and leaves the document alone', () => {
		const {session, store, commands, pointer} = harness();
		expect(session.getOverlayState()?.canvasCursor).toBe('grab');
		session.pointerDown(pointer(10, 20));
		expect(session.getOverlayState()?.canvasCursor).toBe('grabbing');
		session.pointerMove(pointer(40, 8));
		session.pointerMove(pointer(45, 8));
		expect(store.getSnapshot().transform.panX).toBe(55);
		expect(store.getSnapshot().transform.panY).toBe(-20);
		expect(store.getSnapshot().transform.zoom).toBe(1.5);
		expect(store.getSnapshot().followsFit).toBe(false);
		session.pointerUp(pointer(45, 8, 0));
		session.pointerCancel('lostpointercapture');
		expect(session.status).toBe('idle');
		expect(session.getOverlayState()?.canvasCursor).toBe('grab');
		expect(store.getSnapshot().transform.panX).toBe(55);
		expect(commands).toEqual([]);
	});

	it('drops the gesture on cancel without a document command', () => {
		const {session, store, commands, pointer} = harness();
		session.pointerDown(pointer(0, 0));
		session.pointerMove(pointer(12, 4));
		session.pointerCancel('pointercancel');
		expect(session.status).toBe('cancelled');
		expect(store.getSnapshot().transform.panX).toBe(32);
		session.pointerMove(pointer(40, 4));
		expect(store.getSnapshot().transform.panX).toBe(32);
		expect(commands).toEqual([]);
	});
});
