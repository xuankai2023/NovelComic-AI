import {describe, expect, it} from 'vitest';
import {appendImageSequence} from '../comic/append-image-sequence';
import {COMIC_ERROR_CODES, ComicEditorError} from '../comic/errors';
import {applyCommand} from './apply-command';
import {createComicProject} from './build-state';

const hosts = ['cdn.example.com'];

describe('applyCommand', () => {
	it('returns the reordered project and leaves the input unchanged', () => {
		const project = createComicProject();
		const snapshot = structuredClone(project);
		const result = applyCommand({
			project,
			command: (current) => {
				return appendImageSequence(current, {
					allowedHosts: hosts,
					images: [
						{
							shotId: 'shot-1',
							url: 'https://cdn.example.com/a.png',
							width: 1080,
							height: 1920,
							durationInFrames: 30,
						},
					],
				});
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.shots).toHaveLength(1);
			expect(result.value.tracks).toHaveLength(1);
		}

		expect(project).toEqual(snapshot);
	});

	it('returns a domain error without changing the input', () => {
		const project = createComicProject();
		const snapshot = structuredClone(project);
		const result = applyCommand({
			project,
			command: () => {
				throw new ComicEditorError({
					code: COMIC_ERROR_CODES.DOMAIN_INVARIANT,
					message: 'Shot is locked',
					retryable: false,
					status: 422,
					shotId: 'shot-1',
				});
			},
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe(COMIC_ERROR_CODES.DOMAIN_INVARIANT);
			expect(result.error.status).toBe(422);
			expect(result.error.shotId).toBe('shot-1');
		}

		expect(project).toEqual(snapshot);
	});

	it('returns a validation error without changing the input', () => {
		const project = createComicProject();
		const snapshot = structuredClone(project);
		const result = applyCommand({
			project,
			command: (current) => {
				return {
					...current,
					tracks: [
						{
							id: 'track-missing',
							items: ['missing-item'],
							hidden: false,
							muted: false,
						},
					],
				};
			},
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe(COMIC_ERROR_CODES.DOMAIN_INVARIANT);
			expect(result.error.status).toBe(422);
			expect(result.error.itemId).toBe('missing-item');
		}

		expect(project).toEqual(snapshot);
	});

	it('wraps unexpected failures and preserves the input', () => {
		const project = {
			...createComicProject(),
			schemaVersion: 99,
		};
		const snapshot = structuredClone(project);
		const tooNew = applyCommand({
			project,
			command: (current) => current,
		});
		expect(tooNew.ok).toBe(false);
		if (!tooNew.ok) {
			expect(tooNew.error.code).toBe(COMIC_ERROR_CODES.SCHEMA_TOO_NEW);
		}

		const crashed = applyCommand({
			project: createComicProject(),
			command: () => {
				throw new Error('boom');
			},
		});
		expect(crashed.ok).toBe(false);
		if (!crashed.ok) {
			expect(crashed.error.code).toBe(COMIC_ERROR_CODES.INTERNAL);
			expect(crashed.error.status).toBe(500);
		}

		expect(project).toEqual(snapshot);
	});
});
