import {afterEach, describe, expect, it, vi} from 'vitest';
import {
	DEFAULT_AUTO_KEY_ENABLED,
	loadAutoKeyEnabled,
	saveAutoKeyEnabled,
} from './auto-key-persistance';

const storage = new Map<string, string>();

afterEach(() => {
	storage.clear();
	vi.unstubAllGlobals();
});

const installLocalStorage = () => {
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
};

describe('auto-key persistence', () => {
	it('is disabled when no preference has been saved', () => {
		installLocalStorage();
		expect(loadAutoKeyEnabled()).toBe(DEFAULT_AUTO_KEY_ENABLED);
		expect(DEFAULT_AUTO_KEY_ENABLED).toBe(false);
	});

	it('restores the last explicit preference', () => {
		installLocalStorage();

		saveAutoKeyEnabled(true);
		expect(loadAutoKeyEnabled()).toBe(true);

		saveAutoKeyEnabled(false);
		expect(loadAutoKeyEnabled()).toBe(false);
	});
});
