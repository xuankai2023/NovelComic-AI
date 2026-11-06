import {afterEach, describe, expect, it, vi} from 'vitest';
import {createAutosaveScheduler} from './autosave-controller';

describe('autosave scheduler', () => {
	afterEach(() => vi.useRealTimers());

	it('debounces edits and flushes after one second of inactivity', () => {
		vi.useFakeTimers();
		const onFlush = vi.fn();
		const scheduler = createAutosaveScheduler(onFlush);
		scheduler.notifyDirty();
		scheduler.notifyDirty();
		vi.advanceTimersByTime(999);
		expect(onFlush).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFlush).toHaveBeenCalledTimes(1);
	});

	it('guarantees a five second flush during continuous edits', () => {
		vi.useFakeTimers();
		const onFlush = vi.fn();
		const scheduler = createAutosaveScheduler(onFlush);
		for (let halfSecond = 0; halfSecond < 10; halfSecond += 1) {
			scheduler.notifyDirty();
			vi.advanceTimersByTime(500);
		}
		vi.advanceTimersByTime(1);
		expect(onFlush).toHaveBeenCalledTimes(1);
	});

	it('cancel prevents a queued save', () => {
		vi.useFakeTimers();
		const onFlush = vi.fn();
		const scheduler = createAutosaveScheduler(onFlush);
		scheduler.notifyDirty();
		scheduler.cancel();
		vi.advanceTimersByTime(5000);
		expect(onFlush).not.toHaveBeenCalled();
	});
});
