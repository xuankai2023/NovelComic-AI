import type {MarqueeMode} from '../../document/selection-geometry';

/** Freehand drags an outline. Polygonal places one corner per click. */
export type LassoKind = 'freehand' | 'polygonal';

export type LassoToolSettings = {
	kind: LassoKind;
	mode: MarqueeMode;
	/** Shift adds and Option subtracts while held. An outline keeps the mode it started with. */
	held: MarqueeMode | null;
	draftMode: MarqueeMode | null;
	draftActive: boolean;
	antialiased: boolean;
	expandAmount: number;
	contractAmount: number;
	featherAmount: number;
};

const defaults = (): LassoToolSettings => ({
	kind: 'freehand',
	mode: 'replace',
	held: null,
	draftMode: null,
	draftActive: false,
	antialiased: true,
	expandAmount: 1,
	contractAmount: 1,
	featherAmount: 2,
});

let settings = defaults();
const listeners = new Set<() => void>();

const same = (next: LassoToolSettings) =>
	next.kind === settings.kind &&
	next.mode === settings.mode &&
	next.held === settings.held &&
	next.draftMode === settings.draftMode &&
	next.draftActive === settings.draftActive &&
	next.antialiased === settings.antialiased &&
	next.expandAmount === settings.expandAmount &&
	next.contractAmount === settings.contractAmount &&
	next.featherAmount === settings.featherAmount;

const emit = (next: LassoToolSettings) => {
	if (same(next)) return;
	settings = next;
	for (const listener of listeners) listener();
};

export const getLassoToolSettings = () => settings;

export const displayedLassoMode = (value = settings): MarqueeMode =>
	value.draftMode ?? value.held ?? value.mode;

export const updateLassoToolSettings = (patch: Partial<LassoToolSettings>) => {
	emit({...settings, ...patch});
};

export const setLassoKind = (kind: LassoKind) => updateLassoToolSettings({kind});

export const toggleLassoKind = () =>
	setLassoKind(settings.kind === 'freehand' ? 'polygonal' : 'freehand');

export const lassoStatusHint = (kind: LassoKind = settings.kind) =>
	kind === 'polygonal'
		? '点击添加角点 · 点击起点、双击或 Enter 闭合 · Delete 删除角点 · Escape 取消'
		: '拖动绘制选区 · 在选区内拖动可移动 · Shift 添加 · Option 减去 · Delete 清除 · ⌥⌫/⌘⌫ 填充 · ⌘D 取消选择';

export const resetLassoToolSettings = () => {
	settings = defaults();
	for (const listener of listeners) listener();
};

export const subscribeLassoToolSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
