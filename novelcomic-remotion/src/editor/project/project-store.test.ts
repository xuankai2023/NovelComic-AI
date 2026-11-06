import {afterEach, describe, expect, it, vi} from 'vitest';
import {hashProjectState} from './project-hash';
import {browserProjectHash} from './browser-project-hash';
import {
	LEGACY_STATE_STORAGE_KEY,
	ProjectStorageError,
	ProjectStore,
	resetProjectDatabaseConnection,
} from './project-store';

afterEach(() => {
	vi.unstubAllGlobals();
	resetProjectDatabaseConnection();
});

describe('project storage boundaries', () => {
	it('reports a clear error when IndexedDB is unavailable', async () => {
		vi.stubGlobal('indexedDB', undefined);
		await expect(new ProjectStore().listProjects()).rejects.toMatchObject({
			name: 'ProjectStorageError',
			code: 'unavailable',
		});
	});

	it('hashes state content without project metadata', () => {
		const state = {
			tracks: [],
			assets: {},
			items: {},
			fps: 30,
			compositionWidth: 1080,
			compositionHeight: 1920,
			deletedAssets: [],
		};
		expect(hashProjectState(state)).toBe(hashProjectState({...state}));
	});

	it('uses one hash contract and includes PropertyGraph edits', () => {
		const state = {
			tracks: [],
			assets: {},
			items: {},
			fps: 30,
			compositionWidth: 1080,
			compositionHeight: 1920,
			deletedAssets: [],
			propertyGraph: {version: 1 as const, sets: {}},
		};
		const changed = {
			...state,
			propertyGraph: {
				version: 1 as const,
				sets: {
					'item:item-1': {
						owner: {kind: 'item' as const, id: 'item-1'},
						loop: 'none' as const,
						properties: {},
					},
				},
			},
		};
		expect(browserProjectHash(state)).toBe(hashProjectState(state));
		expect(hashProjectState(changed)).not.toBe(hashProjectState(state));
	});

	it('keeps legacy JSON available when migration cannot access storage', async () => {
		const rawStateJson = JSON.stringify({tracks: []});
		vi.stubGlobal('localStorage', {
			getItem: (key: string) =>
				key === LEGACY_STATE_STORAGE_KEY ? rawStateJson : null,
			setItem: vi.fn(),
		});
		vi.stubGlobal('indexedDB', undefined);

		const result = await new ProjectStore().migrateLegacyState();
		expect(result.status).toBe('failed');
		if (result.status === 'failed') {
			expect(result.rawStateJson).toBe(rawStateJson);
			expect(result.error).toBeInstanceOf(ProjectStorageError);
		}
	});
});
