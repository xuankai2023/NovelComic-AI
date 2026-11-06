import {beforeEach, describe, expect, it} from 'vitest';
import {createEmptyDocument} from '../../document/defaults';
import {getBrushToolSettings, resetBrushToolSettings, setBrushForeground} from '../brush/brush-settings';
import {eyedropperCursor} from '../eyedropper/eyedropper-cursor';
import {SAMPLE_RING_BAND, SAMPLE_RING_HALO, SAMPLE_RING_INSET, SAMPLE_RING_SIZE} from '../eyedropper/sample-ring-metrics';
import {resetEyedropperSettings, setShowsSampleRing} from '../eyedropper/eyedropper-settings';
import type {ToolModifiers, ToolPointerEvent, ToolPoint, ToolSessionContext} from '../types';
import {EyedropperToolSession} from './eyedropper-tool-session';

const modifiers = (patch: Partial<ToolModifiers> = {}): ToolModifiers => ({
	shift: false,
	alt: false,
	meta: false,
	control: false,
	space: false,
	...patch,
});

const harness = (
	sample: (point: ToolPoint) => {r: number; g: number; b: number; a: number} | null,
) => {
	const commands: string[] = [];
	const context = {
		document: createEmptyDocument({width: 32, height: 32}),
		selectedLayerIds: [],
		activeLayerId: null,
		viewport: {
			viewport: {width: 400, height: 300},
			document: {width: 32, height: 32},
			transform: {zoom: 2, panX: 0, panY: 0, rotation: 0, devicePixelRatio: 1},
			followsFit: false,
			pointsPerPixel: 2,
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
		setViewportPan: () => undefined,
		setViewportZoom: () => undefined,
		sampleComposite: sample,
	} satisfies ToolSessionContext;
	const session = new EyedropperToolSession(context);
	const pointer = (x: number, y: number, keys: Partial<ToolModifiers> = {}, buttons = 1): ToolPointerEvent => ({
		pointerId: 1,
		pointerType: 'mouse',
		buttons,
		pressure: 1,
		clickCount: 1,
		clientPoint: {x, y},
		viewportPoint: {x, y},
		documentPoint: {x, y},
		modifiers: modifiers(keys),
	});
	return {session, pointer, commands};
};

describe('eyedropper tool session', () => {
	beforeEach(() => {
		resetBrushToolSettings();
		resetEyedropperSettings();
		setBrushForeground({r: 1, g: 2, b: 3});
	});

	it('samples the composited pixel into the foreground color and shows the ring', () => {
		const tool = harness((point) => ({r: point.x + 10, g: 20, b: 30, a: 255}));
		tool.session.pointerDown(tool.pointer(4.8, 6.2));
		expect(getBrushToolSettings().foreground).toEqual({r: 14, g: 20, b: 30});
		expect(tool.session.getOverlayState()?.sampleRing).toEqual({
			x: 4.8,
			y: 6.2,
			original: {r: 1, g: 2, b: 3},
			sampled: {r: 14, g: 20, b: 30},
		});
		expect(tool.session.status).toBe('active');
		expect(tool.commands).toEqual([]);
	});

	it('keeps sampling while dragged and hides the ring on release without reverting', () => {
		const tool = harness((point) => ({r: point.x, g: point.y, b: 7, a: 255}));
		tool.session.pointerDown(tool.pointer(1, 2));
		tool.session.pointerMove(tool.pointer(8.4, 9));
		expect(getBrushToolSettings().foreground).toEqual({r: 8, g: 9, b: 7});
		expect(tool.session.getOverlayState()?.sampleRing?.original).toEqual({r: 1, g: 2, b: 3});
		tool.session.pointerUp(tool.pointer(8.4, 9));
		expect(getBrushToolSettings().foreground).toEqual({r: 8, g: 9, b: 7});
		expect(tool.session.getOverlayState()?.sampleRing).toBeNull();
		expect(tool.session.status).toBe('idle');
		expect(tool.commands).toEqual([]);
	});

	it('leaves the foreground alone over transparency and outside the canvas', () => {
		const tool = harness((point) => (point.x < 0 || point.y < 0 ? null : {r: 9, g: 9, b: 9, a: point.x === 3 ? 0 : 255}));
		tool.session.pointerDown(tool.pointer(3.2, 1));
		expect(getBrushToolSettings().foreground).toEqual({r: 1, g: 2, b: 3});
		expect(tool.session.getOverlayState()?.sampleRing?.sampled).toEqual({r: 1, g: 2, b: 3});
		tool.session.pointerMove(tool.pointer(-1, 4));
		expect(getBrushToolSettings().foreground).toEqual({r: 1, g: 2, b: 3});
		tool.session.pointerMove(tool.pointer(5, 5));
		expect(getBrushToolSettings().foreground).toEqual({r: 9, g: 9, b: 9});
	});

	it('hides the ring when Sample Ring is off and still writes the color', () => {
		setShowsSampleRing(false);
		const tool = harness(() => ({r: 4, g: 5, b: 6, a: 128}));
		tool.session.pointerDown(tool.pointer(1, 1));
		expect(getBrushToolSettings().foreground).toEqual({r: 4, g: 5, b: 6});
		expect(tool.session.getOverlayState()?.sampleRing).toBeNull();
		expect(tool.session.getOverlayState()?.canvasCursor).toBe(eyedropperCursor);
	});

	it('drops the ring when the toggle turns off mid-drag', () => {
		const tool = harness(() => ({r: 8, g: 0, b: 0, a: 255}));
		tool.session.pointerDown(tool.pointer(2, 2));
		expect(tool.session.getOverlayState()?.sampleRing).not.toBeNull();
		setShowsSampleRing(false);
		expect(tool.session.getOverlayState()?.sampleRing).toBeNull();
		expect(getBrushToolSettings().foreground).toEqual({r: 8, g: 0, b: 0});
		tool.session.dispose();
	});

	it('keeps the sampled color when the drag is cancelled', () => {
		const tool = harness(() => ({r: 12, g: 13, b: 14, a: 255}));
		tool.session.pointerDown(tool.pointer(1, 1));
		tool.session.pointerCancel('escape');
		expect(getBrushToolSettings().foreground).toEqual({r: 12, g: 13, b: 14});
		expect(tool.session.getOverlayState()?.sampleRing).toBeNull();
		expect(tool.session.status).toBe('idle');
	});

	it('ignores space and a non-primary button', () => {
		const tool = harness(() => ({r: 9, g: 9, b: 9, a: 255}));
		tool.session.pointerDown(tool.pointer(1, 1, {space: true}));
		tool.session.pointerDown(tool.pointer(1, 1, {}, 2));
		expect(getBrushToolSettings().foreground).toEqual({r: 1, g: 2, b: 3});
		expect(tool.session.getOverlayState()?.sampleRing).toBeNull();
	});

	it('matches the sample ring from SampleRingOverlay', () => {
		expect(SAMPLE_RING_SIZE).toBe(116);
		expect(SAMPLE_RING_INSET).toBe(15);
		expect(SAMPLE_RING_HALO).toBe(24);
		expect(SAMPLE_RING_BAND).toBe(16);
	});
});
