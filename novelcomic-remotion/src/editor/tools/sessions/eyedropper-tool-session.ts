import {getBrushToolSettings, setBrushForeground, type BrushColor} from '../brush/brush-settings';
import {eyedropperCursor} from '../eyedropper/eyedropper-cursor';
import {getEyedropperSettings, subscribeEyedropperSettings} from '../eyedropper/eyedropper-settings';
import type {ToolCancelReason, ToolPointerEvent, ToolPoint} from '../types';
import {BaseToolSession} from './base';

const finite = (point: ToolPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

const copyColor = (color: BrushColor): BrushColor => ({r: color.r, g: color.g, b: color.b});

/**
 * Eyedropper (I), matching EditorCanvas.sampleColor.
 * A press samples the composited pixel into the foreground color immediately.
 * Dragging keeps sampling. Releasing only hides the comparison ring; the color stays.
 * Fully transparent pixels and points outside the canvas are left alone.
 * The sample is the renderer's composited pixel, never one layer's stored buffer.
 */
export class EyedropperToolSession extends BaseToolSession {
	private sampling = false;
	private point: ToolPoint | null = null;
	private original: BrushColor | null = null;
	private readonly unsubscribe: () => void;

	constructor(context: ConstructorParameters<typeof BaseToolSession>[1]) {
		super('eyedropper', context);
		this.publish();
		this.unsubscribe = subscribeEyedropperSettings(() => {
			if (this._status === 'disposed') return;
			this.publish();
			this.context.notifyOverlay?.();
		});
	}

	pointerDown(event: ToolPointerEvent) {
		if (event.modifiers.space || (event.buttons & 1) !== 1 || !finite(event.documentPoint)) return;
		this.original = copyColor(getBrushToolSettings().foreground);
		this.sampling = true;
		this._status = 'active';
		this.sample(event.documentPoint);
	}

	pointerMove(event: ToolPointerEvent) {
		if (!this.sampling || !finite(event.documentPoint)) return;
		this.sample(event.documentPoint);
	}

	pointerUp(_event: ToolPointerEvent) {
		void _event;
		this.finish();
	}

	pointerCancel(reason: ToolCancelReason) {
		if (this._status === 'disposed') return;
		if (reason === 'lostpointercapture' && !this.sampling) return;
		this.finish();
	}

	dispose() {
		this.unsubscribe();
		super.dispose();
	}

	/** One document pixel, floored the way `sampleCompositeColor` rounds down. */
	private sample(point: ToolPoint) {
		this.point = {x: point.x, y: point.y};
		const sampled = this.context.sampleComposite?.({x: Math.floor(point.x), y: Math.floor(point.y)});
		if (sampled && sampled.a > 0) setBrushForeground({r: sampled.r, g: sampled.g, b: sampled.b});
		this.publish();
	}

	/** The ring goes away. The foreground color already written during the drag stays. */
	private finish() {
		this.sampling = false;
		this.point = null;
		this.original = null;
		if (this._status !== 'disposed') this._status = 'idle';
		this.publish();
	}

	private publish() {
		const foreground = getBrushToolSettings().foreground;
		const point = this.point;
		const original = this.original;
		this.overlay = {
			canvasCursor: eyedropperCursor,
			sampleRing:
				this.sampling && getEyedropperSettings().showsSampleRing && point && original
					? {
							x: point.x,
							y: point.y,
							original: copyColor(original),
							sampled: copyColor(foreground),
						}
					: null,
		};
	}
}
