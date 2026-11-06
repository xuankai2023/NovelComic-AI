import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {projectContentHash} from './content-hash';
import {buildDeliveryManifest} from './delivery-manifest';
import {verifyDeliveryPackage} from './verify-package';
import {createStoredZip} from './zip';

const checksum = (body: string): string =>
	createHash('sha256').update(body).digest('hex');

describe('verifyDeliveryPackage', () => {
	it('verifies packaged files and the project content hash', () => {
		const project = createComicProject();
		const sourceBody = 'source-bytes';
		const manifest = buildDeliveryManifest({
			projectId: 'project-1',
			project,
			batches: [],
			files: [
				{
					path: 'source/page.png',
					category: 'source',
					order: 0,
					url: 'https://cdn.example.com/page.png',
					checksum: checksum(sourceBody),
				},
			],
			generatedAt: '2026-10-05T00:00:00.000Z',
		});
		const archive = createStoredZip([
			{
				path: 'project/project.json',
				body: JSON.stringify(project),
			},
			{path: 'manifest.json', body: JSON.stringify(manifest)},
			{path: 'source/page.png', body: sourceBody},
		]);

		const result = verifyDeliveryPackage(archive);

		expect(result.valid).toBe(true);
		expect(result.checkedFiles).toBe(1);
		expect(result.failures).toEqual([]);
		expect(result.manifest.projectContentHash).toBe(
			projectContentHash(project),
		);
	});

	it('reports a checksum mismatch without crashing package inspection', () => {
		const project = createComicProject();
		const manifest = buildDeliveryManifest({
			projectId: 'project-1',
			project,
			batches: [],
			files: [
				{
					path: 'source/page.png',
					category: 'source',
					order: 0,
					url: 'https://cdn.example.com/page.png',
					checksum: 'wrong',
				},
			],
		});
		const archive = createStoredZip([
			{
				path: 'project/project.json',
				body: JSON.stringify(project),
			},
			{path: 'manifest.json', body: JSON.stringify(manifest)},
			{path: 'source/page.png', body: 'source-bytes'},
		]);

		const result = verifyDeliveryPackage(archive);

		expect(result.valid).toBe(false);
		expect(result.failures).toContain('Checksum mismatch for source/page.png');
	});

	it('keeps manifest-declared missing files as warnings', () => {
		const project = createComicProject();
		const manifest = buildDeliveryManifest({
			projectId: 'project-1',
			project,
			batches: [],
			files: [],
		});
		const archive = createStoredZip([
			{
				path: 'project/project.json',
				body: JSON.stringify(project),
			},
			{path: 'manifest.json', body: JSON.stringify(manifest)},
		]);

		const result = verifyDeliveryPackage(archive);

		expect(result.valid).toBe(true);
		expect(result.missingFiles).toContain('missing/source');
		expect(result.failures).toEqual([]);
	});
});
