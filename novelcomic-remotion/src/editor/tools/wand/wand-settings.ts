import type {MarqueeMode} from '../../document/selection-geometry';
import type {WandSampleSize} from '../../pixels/wand';

export type WandToolSettings = {
	mode: MarqueeMode;
	/** Shift adds and Option subtracts while held. */
	held: MarqueeMode | null;
	tolerance: number;
	sampleSize: WandSampleSize;
	/** Read the visible composite rather than just the active layer. */
	sampleAllLayers: boolean;
	/** Only similar pixels connected to the clicked one. */
	contiguous: boolean;
	antialiased: boolean;
	expandAmount: number;
	contractAmount: number;
	featherAmount: number;
	error: string | null;
};

const defaults = (): WandToolSettings => ({
	mode: 'replace',
	held: null,
	tolerance: 32,
	sampleSize: 'point',
	sampleAllLayers: false,
	contiguous: true,
	antialiased: true,
	expandAmount: 1,
	contractAmount: 1,
	featherAmount: 2,
	error: null,
});

let settings = defaults();
const listeners = new Set<() => void>();

const same = (next: WandToolSettings) =>
	next.mode === settings.mode &&
	next.held === settings.held &&
	next.tolerance === settings.tolerance &&
	next.sampleSize === settings.sampleSize &&
	next.sampleAllLayers === settings.sampleAllLayers &&
	next.contiguous === settings.contiguous &&
	next.antialiased === settings.antialiased &&
	next.expandAmount === settings.expandAmount &&
	next.contractAmount === settings.contractAmount &&
	next.featherAmount === settings.featherAmount &&
	next.error === settings.error;

const emit = (next: WandToolSettings) => {
	if (same(next)) return;
	settings = next;
	for (const listener of listeners) listener();
};

export const getWandToolSettings = () => settings;

export const displayedWandMode = (value = settings): MarqueeMode => value.held ?? value.mode;

export const updateWandToolSettings = (patch: Partial<WandToolSettings>) => {
	emit({...settings, ...patch});
};

export const setWandError = (error: string | null) => updateWandToolSettings({error});

export const wandStatusHint = () =>
	'点击选取相近颜色 · Shift 添加 · Option 减去 · 在选区内拖动可移动 · ⌘ 拖动移动像素 · Delete 清除 · ⌘D 取消选择';

export const resetWandToolSettings = () => {
	settings = defaults();
	for (const listener of listeners) listener();
};

export const subscribeWandToolSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
