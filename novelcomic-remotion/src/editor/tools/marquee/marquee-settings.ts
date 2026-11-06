import type {MarqueeMode, MarqueeOutline} from '../../document/selection-geometry';

export type MarqueeToolSettings = {
	kind: MarqueeOutline;
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

const defaults = (): MarqueeToolSettings => ({
	kind: 'rectangle',
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

const same = (next: MarqueeToolSettings) =>
	next.kind === settings.kind &&
	next.mode === settings.mode &&
	next.held === settings.held &&
	next.draftMode === settings.draftMode &&
	next.draftActive === settings.draftActive &&
	next.antialiased === settings.antialiased &&
	next.expandAmount === settings.expandAmount &&
	next.contractAmount === settings.contractAmount &&
	next.featherAmount === settings.featherAmount;

const emit = (next: MarqueeToolSettings) => {
	if (same(next)) return;
	settings = next;
	for (const listener of listeners) listener();
};

export const getMarqueeToolSettings = () => settings;

export const displayedMarqueeMode = (value = settings): MarqueeMode =>
	value.draftMode ?? value.held ?? value.mode;

export const updateMarqueeToolSettings = (patch: Partial<MarqueeToolSettings>) => {
	emit({...settings, ...patch});
};

export const setMarqueeKind = (kind: MarqueeOutline) => updateMarqueeToolSettings({kind});

export const toggleMarqueeKind = () =>
	setMarqueeKind(settings.kind === 'rectangle' ? 'ellipse' : 'rectangle');

export const marqueeStatusHint = (kind: MarqueeOutline = settings.kind) =>
	kind === 'ellipse'
		? '拖出椭圆 · Shift 添加 · Option 减去 · 松开后再按 Shift 为圆形 · 在选区内拖动可移动 · Delete 清除 · ⌘D 取消选择'
		: '拖出矩形 · Shift 添加 · Option 减去 · 松开后再按 Shift 为正方形 · 在选区内拖动可移动 · ⌘ 拖动移动像素 · Delete 清除 · ⌘D 取消选择';

export const resetMarqueeToolSettings = () => {
	settings = defaults();
	for (const listener of listeners) listener();
};

export const subscribeMarqueeToolSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
