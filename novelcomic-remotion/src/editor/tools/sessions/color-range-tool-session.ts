import {ACTIVE_SELECTION_ID, selectionRecord} from '../../document/selection-geometry';
import type {SelectionRecord} from '../../document/types';
import {
	colorRangeMask,
	colorRangePreview,
	sampleColorRangeColor,
	traceColorRange,
} from '../../pixels/color-range';
import type {PixelBuffer} from '../../pixels/pixel-tools';
import {WandError} from '../../pixels/wand';
import {
	displayedColorRangeMode,
	getColorRangeSettings,
	disarmColorRangeLeave,
	requestColorRangeLeave,
	resetColorRangeSettings,
	setColorRangeActions,
	subscribeColorRangeSettings,
	updateColorRangeSettings,
	type ColorRangeSampleMode,
	type ColorRangeSettings,
} from '../color-range/color-range-settings';
import {eyedropperCursorWith} from '../eyedropper/eyedropper-cursor';
import type {ToolCancelReason, ToolKeyEvent, ToolModifiers, ToolPointerEvent} from '../types';
import {BaseToolSession} from './base';

const finitePoint = (point: {x: number; y: number}) => Number.isFinite(point.x) && Number.isFinite(point.y);

/**
 * Select > Color Range. Clicks sample the visible composite. The selection shown is a
 * preview until OK writes one undo step, or Cancel / Escape puts the previous one back.
 */
export class ColorRangeToolSession extends BaseToolSession {
	private readonly sample: PixelBuffer | null;
	private readonly antialiased: boolean;
	private readonly unsubscribe: () => void;
	private silent = false;
	private done = false;
	/** The preview outline. Null is an empty selection once `outlined` is set. */
	private result: SelectionRecord | null = null;
	private outlined = false;

	constructor(context: ConstructorParameters<typeof BaseToolSession>[1]) {
		super('color-range', context);
		resetColorRangeSettings();
		const document = context.document;
		const sampled = context.readWandSample?.(true) ?? null;
		this.sample = sampled && sampled.width === document.width && sampled.height === document.height ? sampled : null;
		this.antialiased = document.selections[ACTIVE_SELECTION_ID]?.geometry?.antialiased ?? true;
		if (!this.sample) updateColorRangeSettings({error: '还读不到图层像素。'});
		setColorRangeActions({
			commit: () => this.commit(),
			cancel: () => this.cancel(),
		});
		this.unsubscribe = subscribeColorRangeSettings(() => {
			if (this.silent || this._status === 'disposed' || this.done) return;
			this.recompute();
		});
		this.paint();
	}

	pointerDown(event: ToolPointerEvent) {
		if (event.modifiers.space || !this.sample || !finitePoint(event.documentPoint)) return;
		this.publishHeld(event.modifiers);
		const color = sampleColorRangeColor(this.sample, event.documentPoint);
		if (!color) return;
		const settings = getColorRangeSettings();
		const mode: ColorRangeSampleMode = event.modifiers.alt ? 'remove' : event.modifiers.shift ? 'add' : settings.sampleMode;
		if (mode === 'replace') this.write({include: [...color], exclude: []});
		else if (mode === 'add') this.write({include: settings.include.concat(color)});
		else this.write({exclude: settings.exclude.concat(color)});
		this.recompute();
		super.pointerDown(event);
	}

	pointerMove(event: ToolPointerEvent) {
		this.publishHeld(event.modifiers);
		this.paint();
	}

	pointerUp(event: ToolPointerEvent) {
		this.publishHeld(event.modifiers);
		super.pointerUp(event);
		this.paint();
	}

	pointerCancel(reason: ToolCancelReason) {
		if (reason === 'escape') this.cancel();
		super.pointerCancel(reason);
	}

	keyDown(event: ToolKeyEvent) {
		if (event.key !== 'Shift' && event.key !== 'Alt' && event.key !== 'Meta' && event.key !== 'Control') return false;
		this.publishHeld(event.modifiers);
		this.paint();
		return true;
	}

	keyUp(event: ToolKeyEvent) {
		if (event.key !== 'Shift' && event.key !== 'Alt' && event.key !== 'Meta' && event.key !== 'Control') return false;
		this.publishHeld(event.modifiers);
		this.paint();
		return true;
	}

	dispose() {
		this.unsubscribe();
		setColorRangeActions(null);
		disarmColorRangeLeave();
		resetColorRangeSettings();
		super.dispose();
	}

	private publishHeld(modifiers: ToolModifiers) {
		const held = modifiers.alt ? 'remove' : modifiers.shift ? 'add' : null;
		this.write({held});
	}

	private cursor() {
		const mode = displayedColorRangeMode();
		return eyedropperCursorWith(mode === 'replace' ? undefined : mode);
	}

	private write(patch: Partial<ColorRangeSettings>) {
		this.silent = true;
		updateColorRangeSettings(patch);
		this.silent = false;
	}

	private paint() {
		const cursor = this.cursor();
		this.overlay = this.outlined
			? {canvasCursor: cursor, selectionPreview: this.result}
			: {canvasCursor: cursor};
		this.context.notifyOverlay?.();
	}

	private recompute() {
		const settings = getColorRangeSettings();
		const sample = this.sample;
		if (!sample || settings.include.length === 0) {
			this.result = null;
			this.outlined = false;
			this.write({preview: null, error: sample ? null : settings.error});
			this.paint();
			return;
		}
		const mask = new Uint8Array(sample.width * sample.height);
		colorRangeMask(
			sample.data,
			sample.width,
			sample.height,
			sample.width * 4,
			settings.include,
			settings.exclude,
			settings.fuzziness,
			settings.invert,
			mask,
		);
		const preview = colorRangePreview(mask, sample.width, sample.height);
		try {
			const loops = traceColorRange(mask, sample.width, sample.height);
			this.write({preview, error: null});
			this.outlined = true;
			this.result = loops
				? selectionRecord({kind: 'loops', loops}, {feather: 0, antialiased: this.antialiased})
				: null;
		} catch (error) {
			this.write({
				preview,
				error: error instanceof WandError ? error.message : '无法建立这个选区。',
			});
		}
		this.paint();
	}

	private commit() {
		if (this.done || this._status === 'disposed') return;
		this.done = true;
		const settings = getColorRangeSettings();
		if (settings.include.length > 0 && !settings.error) this.context.commitSelection(this.result);
		requestColorRangeLeave();
	}

	private cancel() {
		if (this.done || this._status === 'disposed') return;
		this.done = true;
		requestColorRangeLeave();
	}
}
