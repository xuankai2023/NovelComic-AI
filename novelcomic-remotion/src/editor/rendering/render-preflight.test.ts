import {describe, expect, it, vi} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {projectContentHash} from '../project/project-hash';
import type {ProjectSnapshot} from '../project/types';
import {runRenderPreflight, type ComposeCapabilities} from './render-preflight';

const capabilities = (
	override: Partial<ComposeCapabilities> = {},
): ComposeCapabilities => ({
	renderBackend: 'local',
	local: {available: true},
	lambda: {configured: true},
	ffmpeg: {available: true},
	cos: {configured: true},
	fonts: {available: true},
	exportPackage: {available: true},
	...override,
});

const snapshotFor = (state: ReturnType<typeof createComicProject>): ProjectSnapshot => ({
	snapshotId: 'snapshot-1',
	projectId: 'project-1',
	revision: 1,
	savedAt: '2026-10-06T00:00:00.000Z',
	reason: 'manual',
	contentHash: projectContentHash(state),
	state,
});

const fetchFor = (issues: unknown[], caps: ComposeCapabilities) =>
	vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		return Response.json(
			url.includes('/validate') ? {valid: issues.length === 0, issues} : caps,
		);
	}) as typeof fetch;

describe('runRenderPreflight', () => {
	it('blocks project errors and unavailable delivery dependencies', async () => {
		const project = createComicProject();
		const result = await runRenderPreflight({
			project,
			snapshot: snapshotFor(project),
			purpose: 'delivery',
			fetchImpl: fetchFor(
				[{severity: 'error', code: 'BROKEN_PROJECT', message: 'Broken'}],
				capabilities({
					ffmpeg: {available: false, reason: 'missing ffmpeg'},
					cos: {configured: false, reason: 'missing COS'},
					exportPackage: {available: false, reason: 'no upload'},
				}),
			),
		});

		expect(result.status).toBe('blocked');
		expect(result.canSubmit).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				'BROKEN_PROJECT',
				'FFMPEG_UNAVAILABLE',
				'COS_NOT_CONFIGURED',
				'EXPORT_PACKAGE_UNAVAILABLE',
			]),
		);
	});

	it('requires explicit warning confirmation and then preserves the hash', async () => {
		const project = createComicProject();
		const snapshot = snapshotFor(project);
		const fetchImpl = fetchFor(
			[{severity: 'warning', code: 'CHECK_ME', message: 'Review me'}],
			capabilities(),
		);
		const pending = await runRenderPreflight({
			project,
			snapshot,
			purpose: 'full-video',
			fetchImpl,
		});
		const confirmed = await runRenderPreflight({
			project,
			snapshot,
			purpose: 'full-video',
			warningsConfirmed: true,
			fetchImpl,
		});

		expect(pending.status).toBe('confirmation-required');
		expect(confirmed.status).toBe('ready');
		expect(confirmed.preflightHash).toBe(pending.preflightHash);
	});
});
