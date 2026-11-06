import type {WorkspaceToolId} from '../types';

export type ColorRangeSampleMode = 'replace' | 'add' | 'remove';

export type ColorRangePreview = {width: number; height: number; data: Uint8Array};

export type ColorRangeSettings = {
	fuzziness: number;
	invert: boolean;
	sampleMode: ColorRangeSampleMode;
	/** Shift adds and Option takes a color away while held. */
	held: 'add' | 'remove' | null;
	include: number[];
	exclude: number[];
	error: string | null;
	preview: ColorRangePreview | null;
};

export type ColorRangeActions = {
	commit: () => void;
	cancel: () => void;
};

const defaults = (): ColorRangeSettings => ({
	fuzziness: 40,
	invert: false,
	sampleMode: 'replace',
	held: null,
	include: [],
	exclude: [],
	error: null,
	preview: null,
});

let settings = defaults();
let actions: ColorRangeActions | null = null;
let actionsVersion = 0;
let returnTool: WorkspaceToolId | null = null;
let leaveArmed = false;
const listeners = new Set<() => void>();
const leaveListeners = new Set<(tool: WorkspaceToolId) => void>();

const sameColors = (left: readonly number[], right: readonly number[]) =>
	left.length === right.length && left.every((value, index) => value === right[index]);

const same = (next: ColorRangeSettings) =>
	next.fuzziness === settings.fuzziness &&
	next.invert === settings.invert &&
	next.sampleMode === settings.sampleMode &&
	next.held === settings.held &&
	next.error === settings.error &&
	next.preview === settings.preview &&
	sameColors(next.include, settings.include) &&
	sameColors(next.exclude, settings.exclude);

const emit = () => {
	for (const listener of listeners) listener();
};

export const getColorRangeSettings = () => settings;

export const displayedColorRangeMode = (value = settings): ColorRangeSampleMode => value.held ?? value.sampleMode;

export const updateColorRangeSettings = (patch: Partial<ColorRangeSettings>) => {
	const next = {...settings, ...patch};
	if (same(next)) return;
	settings = next;
	emit();
};

export const resetColorRangeSettings = () => {
	settings = defaults();
	emit();
};

export const subscribeColorRangeSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const getColorRangeActions = () => actions;

export const getColorRangeActionsVersion = () => actionsVersion;

export const setColorRangeActions = (next: ColorRangeActions | null) => {
	actions = next;
	actionsVersion += 1;
	emit();
};

/** The tool to restore when the panel closes. A later open replaces it. */
export const rememberColorRangeTool = (tool: WorkspaceToolId) => {
	if (tool !== 'color-range') returnTool = tool;
	leaveArmed = true;
};

/** Drop the remembered tool without switching. Used when the session is disposed by a tool change. */
export const disarmColorRangeLeave = () => {
	leaveArmed = false;
	returnTool = null;
};

export const requestColorRangeLeave = () => {
	if (!leaveArmed) return;
	leaveArmed = false;
	const next = returnTool ?? 'magic-wand';
	returnTool = null;
	for (const listener of leaveListeners) listener(next);
};

export const subscribeColorRangeLeave = (listener: (tool: WorkspaceToolId) => void) => {
	leaveListeners.add(listener);
	return () => leaveListeners.delete(listener);
};

export const colorRangeStatusHint = () =>
	'点击选取颜色 · Shift 添加 · Option 去除 · 确定后写入选区 · Esc 取消';
