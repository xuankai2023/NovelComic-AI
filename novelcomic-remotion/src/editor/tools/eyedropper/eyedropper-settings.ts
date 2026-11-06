/**
 * Eyedropper options. Compositor keeps one toggle, `showsSampleRing`, on the tool
 * header. It is not part of the document and does not enter Undo.
 */
export type EyedropperSettings = {
	showsSampleRing: boolean;
};

const defaults = (): EyedropperSettings => ({
	showsSampleRing: true,
});

let settings = defaults();
const listeners = new Set<() => void>();

const same = (next: EyedropperSettings) => next.showsSampleRing === settings.showsSampleRing;

const emit = (next: EyedropperSettings) => {
	if (same(next)) return;
	settings = next;
	for (const listener of listeners) listener();
};

export const getEyedropperSettings = () => settings;

export const subscribeEyedropperSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const setShowsSampleRing = (showsSampleRing: boolean) => emit({showsSampleRing});

export const eyedropperStatusHint = () => '点击或拖动取样前景色 · 松开保留 · 采样环对比按下前的颜色 · 透明处不取样';

export const resetEyedropperSettings = () => {
	settings = defaults();
	for (const listener of listeners) listener();
};
