import {EASING_NAMES, type EasingName} from './types';

const clampUnit = (value: number): number => {
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}

	if (value >= 1) {
		return 1;
	}

	return value;
};

const easeIn = (progress: number): number => {
	return progress * progress * progress;
};

const easeOut = (progress: number): number => {
	return 1 - (1 - progress) ** 3;
};

const easeInOut = (progress: number): number => {
	if (progress < 0.5) {
		return 4 * progress * progress * progress;
	}

	return 1 - (-2 * progress + 2) ** 3 / 2;
};

const isEasingName = (name: string): name is EasingName => {
	return (EASING_NAMES as readonly string[]).includes(name);
};

export const applyEasing = (name: EasingName, progress: number): number => {
	const t = clampUnit(progress);

	if (!isEasingName(name)) {
		return t;
	}

	switch (name) {
		case 'linear':
			return t;
		case 'ease-in':
			return clampUnit(easeIn(t));
		case 'ease-out':
			return clampUnit(easeOut(t));
		case 'ease-in-out':
			return clampUnit(easeInOut(t));
		default:
			return t;
	}
};
