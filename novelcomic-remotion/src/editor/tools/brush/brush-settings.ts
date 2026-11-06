import type {ToolPoint, WorkspaceToolId} from '../types';

/** Paint lays down the foreground color. Erase clears pixels. B and E, or Tab. */
export type BrushMode = 'paint' | 'erase';

/**
 * Spot Healing's type, in Compositor's SpotHealingMode order.
 * Tab steps through them. Brush and Spot Healing share size, hardness and opacity.
 */
export const SPOT_HEALING_MODES = ['content-aware', 'create-texture', 'proximity-match'] as const;
export type SpotHealingMode = (typeof SPOT_HEALING_MODES)[number];
export const SPOT_HEALING_MODE_LABELS: Record<SpotHealingMode, string> = {
	'content-aware': '内容识别',
	'create-texture': '创建纹理',
	'proximity-match': '近似匹配',
};

export type BrushColor = {r: number; g: number; b: number};

export type BrushToolSettings = {
	/** Document pixels. The options bar stops at 2000, matching Compositor. */
	diameter: number;
	/** 0–1. 1 is a hard disc. */
	hardness: number;
	/** 0.01–1. Caps the whole stroke: overlapping dabs never exceed it. */
	opacity: number;
	/** 0–100. The brush trails the pointer on a string of this many screen points. */
	smoothing: number;
	mode: BrushMode;
	healingMode: SpotHealingMode;
	foreground: BrushColor;
	background: BrushColor;
	/** Why the last press could not paint. Cleared when a stroke starts. */
	error: string | null;
};

const defaults = (): BrushToolSettings => ({
	diameter: 40,
	hardness: 1,
	opacity: 1,
	smoothing: 0,
	mode: 'paint',
	healingMode: 'content-aware',
	foreground: {r: 0, g: 0, b: 0},
	background: {r: 255, g: 255, b: 255},
	error: null,
});

let settings = defaults();
let lastStroke: {point: ToolPoint; layerId: string} | null = null;
let pendingOpacity: {digit: number; time: number} | null = null;
let strokeActive = false;
/**
 * Compositor parks a separate tip per brush family. Clone Stamp is family 1 and
 * starts soft; Brush and Spot Healing share family 0. Smear would be family 2.
 */
let tipFamily = 0;
const parkedTips: Record<number, {diameter: number; hardness: number; opacity: number}> = {
	1: {diameter: 40, hardness: 0, opacity: 1},
};
const listeners = new Set<() => void>();

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const sameColor = (left: BrushColor, right: BrushColor) => left.r === right.r && left.g === right.g && left.b === right.b;
const same = (next: BrushToolSettings) =>
	next.diameter === settings.diameter &&
	next.hardness === settings.hardness &&
	next.opacity === settings.opacity &&
	next.smoothing === settings.smoothing &&
	next.mode === settings.mode &&
	next.healingMode === settings.healingMode &&
	sameColor(next.foreground, settings.foreground) &&
	sameColor(next.background, settings.background) &&
	next.error === settings.error;

const emit = (next: BrushToolSettings) => {
	if (same(next)) return;
	settings = next;
	for (const listener of listeners) listener();
};

const clampDiameter = (value: number) => Math.min(2000, Math.max(1, Math.round(value)));
const clampUnit = (value: number) => Math.min(1, Math.max(0, value));
const clampOpacity = (value: number) => Math.min(1, Math.max(0.01, value));
const clampSmoothing = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

export const getBrushToolSettings = () => settings;

/** Swap the live tip when the tool changes family, the way EditorSession.selectTool does. */
export const activateBrushTip = (toolId: WorkspaceToolId) => {
	const next = toolId === 'clone-stamp' ? 1 : 0;
	if (next === tipFamily) return;
	parkedTips[tipFamily] = {diameter: settings.diameter, hardness: settings.hardness, opacity: settings.opacity};
	const parked = parkedTips[next] ?? {diameter: 40, hardness: next === 1 ? 0 : 1, opacity: 1};
	tipFamily = next;
	emit({...settings, diameter: parked.diameter, hardness: parked.hardness, opacity: parked.opacity, error: null});
};
export const getLastBrushPoint = () => lastStroke;
export const isBrushStrokeActive = () => strokeActive;

export const setBrushStrokeActive = (active: boolean) => {
	strokeActive = active;
};

export const setLastBrushPoint = (point: ToolPoint, layerId: string) => {
	lastStroke = {point: {x: point.x, y: point.y}, layerId};
};

export const updateBrushToolSettings = (patch: Partial<BrushToolSettings>) => {
	const next = {...settings, ...patch};
	if (patch.diameter !== undefined) next.diameter = clampDiameter(patch.diameter);
	if (patch.hardness !== undefined) next.hardness = clampUnit(patch.hardness);
	if (patch.opacity !== undefined) next.opacity = clampOpacity(patch.opacity);
	if (patch.smoothing !== undefined) next.smoothing = clampSmoothing(patch.smoothing);
	if (patch.foreground) next.foreground = {r: clampByte(patch.foreground.r), g: clampByte(patch.foreground.g), b: clampByte(patch.foreground.b)};
	if (patch.background) next.background = {r: clampByte(patch.background.r), g: clampByte(patch.background.g), b: clampByte(patch.background.b)};
	emit(next);
};

export const setBrushMode = (mode: BrushMode) => updateBrushToolSettings({mode, error: null});
export const setHealingMode = (healingMode: SpotHealingMode) => updateBrushToolSettings({healingMode, error: null});
export const cycleHealingMode = () => {
	const index = SPOT_HEALING_MODES.indexOf(settings.healingMode);
	setHealingMode(SPOT_HEALING_MODES[(index + 1) % SPOT_HEALING_MODES.length] ?? 'content-aware');
};
export const setBrushError = (error: string | null) => updateBrushToolSettings({error});
export const setBrushForeground = (color: BrushColor) => updateBrushToolSettings({foreground: color});
export const setBrushBackground = (color: BrushColor) => updateBrushToolSettings({background: color});

export const swapBrushColors = () => {
	emit({...settings, foreground: settings.background, background: settings.foreground});
};

export const resetBrushColors = () => {
	const fresh = defaults();
	emit({...settings, foreground: fresh.foreground, background: fresh.background});
};

export const colorToHex = (color: BrushColor) =>
	`#${[color.r, color.g, color.b].map((channel) => clampByte(channel).toString(16).padStart(2, '0')).join('')}`;

export const hexToColor = (hex: string): BrushColor | null => {
	const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!match?.[1]) return null;
	return {r: parseInt(match[1].slice(0, 2), 16), g: parseInt(match[1].slice(2, 4), 16), b: parseInt(match[1].slice(4, 6), 16)};
};

/**
 * Photoshop-style opacity keys: 1 = 10% … 9 = 90%, 0 = 100%.
 * Two digits typed within 0.6s set an exact value (4 then 5 = 45%).
 */
export const typeBrushOpacityDigit = (digit: number, time = Date.now()) => {
	if (strokeActive || digit < 0 || digit > 9) return false;
	let percent = digit === 0 ? 100 : digit * 10;
	if (pendingOpacity && time - pendingOpacity.time < 600) {
		percent = Math.max(1, pendingOpacity.digit * 10 + digit);
		pendingOpacity = null;
	} else pendingOpacity = {digit, time};
	updateBrushToolSettings({opacity: percent / 100});
	return true;
};

/** Shift-[ / Shift-]: hardness in 25% steps. */
export const changeBrushHardness = (increase: boolean) => {
	if (strokeActive) return false;
	const quarter = settings.hardness * 4;
	const step = increase ? Math.floor(quarter + 0.001) + 1 : Math.ceil(quarter - 0.001) - 1;
	updateBrushToolSettings({hardness: Math.min(4, Math.max(0, step)) / 4});
	return true;
};

/** A step of a fifth, but always at least one pixel, so a 2px brush can still shrink. */
export const changeBrushSize = (increase: boolean) => {
	if (strokeActive) return false;
	const current = settings.diameter;
	const stepped = increase ? Math.max(current + 1, Math.round(current * 1.2)) : Math.min(current - 1, Math.round(current / 1.2));
	updateBrushToolSettings({diameter: stepped});
	return true;
};

export const brushStatusHint = (mode: BrushMode = settings.mode) =>
	mode === 'erase'
		? '拖动擦除像素 · Shift 保持直线 · [ ] 调整大小 · { } 硬度 · 数字键不透明度 · 右键拖动改大小，Shift 右键改硬度'
		: '拖动用前景色绘画 · Shift 保持直线 · Option 取色 · [ ] 调整大小 · { } 硬度 · 数字键不透明度 · 右键拖动改大小，Shift 右键改硬度';

/** Compositor's spot-healing status: drag over a blemish, then size, hardness, cancel and pan. */
export const healingStatusHint = () => '拖过瑕疵进行修复 · [ ] 调整大小 · { } 硬度 · Esc 取消 · 空格平移';

export const resetBrushToolSettings = () => {
	settings = defaults();
	lastStroke = null;
	pendingOpacity = null;
	strokeActive = false;
	tipFamily = 0;
	delete parkedTips[0];
	parkedTips[1] = {diameter: 40, hardness: 0, opacity: 1};
	for (const listener of listeners) listener();
};

export const subscribeBrushToolSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
