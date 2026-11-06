import type {ToolPoint} from '../types';

/** Compositor draws a straight ramp or a ramp that radiates from the start. */
export const GRADIENT_SHAPES = ['linear', 'radial'] as const;
export type GradientShape = (typeof GRADIENT_SHAPES)[number];

/** Foreground fades to the background, or to clear, keeping the foreground hue. */
export const GRADIENT_STYLES = ['foreground-to-background', 'foreground-to-transparent'] as const;
export type GradientStyle = (typeof GRADIENT_STYLES)[number];

export type GradientSettings = {
	shape: GradientShape;
	style: GradientStyle;
	/** Swaps the two stops. */
	reverse: boolean;
	/** 0.01–1. Caps how strongly the ramp replaces the layer. */
	opacity: number;
	/** Why the last press could not draw. Cleared when a drag starts. */
	error: string | null;
};

/** Foreground and background, in the order the line paints them. */
export const gradientColorStops = (
	foreground: {r: number; g: number; b: number},
	background: {r: number; g: number; b: number},
) => {
	const from = {r: foreground.r, g: foreground.g, b: foreground.b, a: 255};
	const to =
		settings.style === 'foreground-to-transparent'
			? {r: foreground.r, g: foreground.g, b: foreground.b, a: 0}
			: {r: background.r, g: background.g, b: background.b, a: 255};
	return settings.reverse ? {from: to, to: from} : {from, to};
};

const defaults = (): GradientSettings => ({
	shape: 'linear',
	style: 'foreground-to-transparent',
	reverse: false,
	opacity: 1,
	error: null,
});

let settings = defaults();
let pendingOpacity: {digit: number; time: number} | null = null;
const listeners = new Set<() => void>();

const same = (next: GradientSettings) =>
	next.shape === settings.shape &&
	next.style === settings.style &&
	next.reverse === settings.reverse &&
	next.opacity === settings.opacity &&
	next.error === settings.error;

const emit = (next: GradientSettings) => {
	if (same(next)) return;
	settings = next;
	for (const listener of listeners) listener();
};

const clampOpacity = (value: number) => Math.min(1, Math.max(0.01, value));

export const getGradientSettings = () => settings;

export const updateGradientSettings = (patch: Partial<GradientSettings>) => {
	const next = {...settings, ...patch};
	if (patch.opacity !== undefined) next.opacity = clampOpacity(patch.opacity);
	emit(next);
};

export const setGradientShape = (shape: GradientShape) => updateGradientSettings({shape, error: null});
export const cycleGradientShape = () => {
	const index = GRADIENT_SHAPES.indexOf(settings.shape);
	setGradientShape(GRADIENT_SHAPES[(index + 1) % GRADIENT_SHAPES.length] ?? 'linear');
};
export const setGradientStyle = (style: GradientStyle) => updateGradientSettings({style, error: null});
export const setGradientReverse = (reverse: boolean) => updateGradientSettings({reverse, error: null});
export const setGradientError = (error: string | null) => updateGradientSettings({error});

type GradientEditActions = {commit: () => void; cancel: () => void};
let edit: GradientEditActions | null = null;

/** True while a line is waiting for Enter, Apply, or a tool change. */
export const getGradientPending = () => edit !== null;
export const getGradientEdit = () => edit;

export const setGradientEdit = (actions: GradientEditActions | null) => {
	const wasPending = edit !== null;
	edit = actions;
	if (wasPending !== (edit !== null)) {
		for (const listener of listeners) listener();
	}
};

/**
 * Drops a pending gradient. Undo uses this and then stops, the way
 * EditorSession.undo discards the line before it touches history.
 */
export const dismissPendingGradient = () => {
	const pending = edit;
	if (!pending) return false;
	pending.cancel();
	return true;
};

/**
 * Photoshop-style opacity keys, shared with the brush: 1 = 10% … 9 = 90%, 0 = 100%.
 * Two digits typed within 0.6s set an exact value.
 */
export const typeGradientOpacityDigit = (digit: number, time = Date.now()) => {
	if (digit < 0 || digit > 9) return false;
	let percent = digit === 0 ? 100 : digit * 10;
	if (pendingOpacity && time - pendingOpacity.time < 600) {
		percent = Math.max(1, pendingOpacity.digit * 10 + digit);
		pendingOpacity = null;
	} else pendingOpacity = {digit, time};
	updateGradientSettings({opacity: percent / 100});
	return true;
};

/** Snaps `point` around `origin` to the nearest 45°, keeping the drag's length. */
export const snapTo45 = (origin: ToolPoint, point: ToolPoint): ToolPoint => {
	const dx = point.x - origin.x;
	const dy = point.y - origin.y;
	const length = Math.hypot(dx, dy);
	if (length < 1e-6) return {x: point.x, y: point.y};
	const step = Math.PI / 4;
	const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
	return {x: origin.x + Math.cos(snapped) * length, y: origin.y + Math.sin(snapped) * length};
};

export const gradientStatusHint = () =>
	'拖动定方向 · 拖端点调整 · Shift 约束 45° · Option 取样 · 数字键不透明度 · Enter 应用 · Esc 取消 · 换工具会应用';

export const resetGradientSettings = () => {
	settings = defaults();
	pendingOpacity = null;
	edit = null;
	for (const listener of listeners) listener();
};

export const subscribeGradientSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
