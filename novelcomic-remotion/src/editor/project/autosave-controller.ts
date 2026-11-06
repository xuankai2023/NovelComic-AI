export type AutosaveSchedulerOptions = {
	debounceMs?: number;
	maxWaitMs?: number;
	setTimeoutFn?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
	clearTimeoutFn?: (timer: ReturnType<typeof setTimeout>) => void;
};

export type AutosaveScheduler = {
	notifyDirty: () => void;
	flush: () => void;
	cancel: () => void;
};

/**
 * Schedules an autosave after a quiet period, while also guaranteeing a
 * maximum wait for a continuously edited project. Keeping this small and
 * dependency-free makes the persistence policy easy to exercise with fake
 * timers and prevents React lifecycle details from leaking into storage code.
 */
export const createAutosaveScheduler = (
	onFlush: () => void,
	options: AutosaveSchedulerOptions = {},
): AutosaveScheduler => {
	const debounceMs = options.debounceMs ?? 1000;
	const maxWaitMs = options.maxWaitMs ?? 5000;
	const setTimer =
		options.setTimeoutFn ??
		((callback: () => void, delay: number) => setTimeout(callback, delay));
	const clearTimer =
		options.clearTimeoutFn ??
		((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let maxTimer: ReturnType<typeof setTimeout> | null = null;

	const clearDebounce = () => {
		if (debounceTimer !== null) {
			clearTimer(debounceTimer);
			debounceTimer = null;
		}
	};

	const clearMax = () => {
		if (maxTimer !== null) {
			clearTimer(maxTimer);
			maxTimer = null;
		}
	};

	const flush = () => {
		clearDebounce();
		clearMax();
		onFlush();
	};

	return {
		notifyDirty: () => {
			if (maxTimer === null) {
				maxTimer = setTimer(flush, maxWaitMs);
			}

			clearDebounce();
			debounceTimer = setTimer(flush, debounceMs);
		},
		flush,
		cancel: () => {
			clearDebounce();
			clearMax();
		},
	};
};
