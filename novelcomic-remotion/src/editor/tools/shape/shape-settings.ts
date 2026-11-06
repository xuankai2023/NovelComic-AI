/**
 * Shape tool options. Compositor keeps these on the tool header (`shapeKind`,
 * `shapeCornerRadius`, `shapeLineWidth`). They are not part of the document
 * and do not enter Undo. The foreground swatch is the shared brush color.
 */
export const SHAPE_KINDS = ['rectangle', 'ellipse', 'line'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export const SHAPE_KIND_NAMES: Record<ShapeKind, string> = {
	rectangle: 'Rectangle',
	ellipse: 'Ellipse',
	line: 'Line',
};

export type ShapeSettings = {
	kind: ShapeKind;
	/** Document pixels. Rectangles only; 0 keeps the corners square. */
	cornerRadius: number;
	/** Document pixels. A line's thickness. */
	lineWidth: number;
	/** Why the last shape could not be created. Cleared when a drag starts. */
	error: string | null;
};

const defaults = (): ShapeSettings => ({
	kind: 'rectangle',
	cornerRadius: 0,
	lineWidth: 4,
	error: null,
});

let settings = defaults();
let cancelDraft: (() => void) | null = null;
const listeners = new Set<() => void>();

const same = (next: ShapeSettings) =>
	next.kind === settings.kind &&
	next.cornerRadius === settings.cornerRadius &&
	next.lineWidth === settings.lineWidth &&
	next.error === settings.error;

const emit = (next: ShapeSettings) => {
	if (same(next)) return;
	settings = next;
	for (const listener of listeners) listener();
};

/** Whole pixels, matching the options-bar fields. */
export const clampShapeLineWidth = (value: number) =>
	Number.isFinite(value) ? Math.min(5000, Math.max(1, Math.round(value))) : 4;

export const clampShapeCornerRadius = (value: number) =>
	Number.isFinite(value) ? Math.min(5000, Math.max(0, Math.round(value))) : 0;

export const getShapeSettings = () => settings;

export const subscribeShapeSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** The open shape session drops its drag when the kind changes, as the options picker does. */
export const setShapeDraftCancel = (cancel: (() => void) | null) => {
	cancelDraft = cancel;
};

export const setShapeKind = (kind: ShapeKind) => {
	cancelDraft?.();
	emit({...settings, kind, error: null});
};

export const cycleShapeKind = () => {
	const index = SHAPE_KINDS.indexOf(settings.kind);
	setShapeKind(SHAPE_KINDS[(index + 1) % SHAPE_KINDS.length] ?? 'rectangle');
};

export const setShapeCornerRadius = (cornerRadius: number) =>
	emit({...settings, cornerRadius: clampShapeCornerRadius(cornerRadius), error: null});

export const setShapeLineWidth = (lineWidth: number) =>
	emit({...settings, lineWidth: clampShapeLineWidth(lineWidth), error: null});

export const setShapeError = (error: string | null) => emit({...settings, error});

export const shapeStatusHint = (kind: ShapeKind = settings.kind) => {
	const label = kind === 'line' ? '直线' : kind === 'ellipse' ? '椭圆' : '矩形';
	return `${label} · 拖拽创建 · Shift 约束比例或角度 · Option 从中心 · Shift-U 或 Tab 切换`;
};

export const resetShapeSettings = () => {
	cancelDraft = null;
	settings = defaults();
	for (const listener of listeners) listener();
};
