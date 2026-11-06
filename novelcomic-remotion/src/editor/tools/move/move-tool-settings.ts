export type MoveToolSettings = {
	autoSelect: boolean;
	showControls: boolean;
	lockRatio: boolean;
};

const defaults = (): MoveToolSettings => ({
	autoSelect: false,
	showControls: true,
	lockRatio: true,
});

let settings = defaults();
const listeners = new Set<() => void>();

const emit = () => {
	for (const listener of listeners) listener();
};

export const getMoveToolSettings = () => settings;

export const updateMoveToolSettings = (patch: Partial<MoveToolSettings>) => {
	settings = {...settings, ...patch};
	emit();
};

export const resetMoveToolSettings = () => {
	settings = defaults();
	emit();
};

export const subscribeMoveToolSettings = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
