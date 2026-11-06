import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {projectContentHash} from './content-hash';
import {buildDeliveryManifest} from './delivery-manifest';
import type {DeliveryFileEntry, OutputBatch} from './types';

const generatedAt = '2026-10-02T00:00:00.000Z';

const batches = (): OutputBatch[] => {
	return [
		{
			batchId: 'batch-b',
			batchIndex: 2,
			fromFrame: 150,
			endFrameInclusive: 299,
			durationInFrames: 150,
			shotIds: ['shot-2'],
			reason: 'target-range',
		},
		{
			batchId: 'batch-a',
			batchIndex: 1,
			fromFrame: 0,
			endFrameInclusive: 149,
			durationInFrames: 150,
			shotIds: ['shot-1'],
			reason: 'target-range',
		},
	];
};

const file = (
	path: string,
	category: DeliveryFileEntry['category'],
	order: number,
	extra?: Partial<DeliveryFileEntry>,
): DeliveryFileEntry => {
	return {
		path,
		category,
		order,
		...extra,
	};
};

const completeFiles = (): DeliveryFileEntry[] => {
	return [
		file('videos/second.mp4', 'final-video', 2, {
			url: 'https://cdn.example.com/second.mp4',
			checksum: 'sum-b',
		}),
		file('source/page.png', 'source', 0, {
			url: 'https://cdn.example.com/page.png',
			checksum: 'sum-source',
		}),
		file('layers/bg.png', 'layer', 0, {
			url: 'https://cdn.example.com/bg.png',
			checksum: 'sum-layer',
		}),
		file('audio/dialog.wav', 'audio', 0, {
			url: 'https://cdn.example.com/dialog.wav',
			checksum: 'sum-audio',
		}),
		file('subtitle/dialog.srt', 'subtitle', 0, {
			url: 'https://cdn.example.com/dialog.srt',
			checksum: 'sum-sub',
		}),
		file('project/project.json', 'project', 0, {
			url: 'https://cdn.example.com/project.json',
			checksum: 'sum-project',
		}),
		file('preview/contact.png', 'preview', 0, {
			url: 'https://cdn.example.com/contact.png',
			checksum: 'sum-preview',
		}),
		file('videos/first.mp4', 'final-video', 1, {
			url: 'https://cdn.example.com/first.mp4',
			checksum: 'sum-a',
		}),
	];
};

describe('buildDeliveryManifest', () => {
	it('records a missing file and missing category without building a zip', () => {
		const project = createComicProject();
		const files = completeFiles().filter((entry) => entry.category !== 'audio');
		files.push(file('subtitle/empty.srt', 'subtitle', 1));

		const manifest = buildDeliveryManifest({
			projectId: 'project-1',
			project,
			batches: batches(),
			files,
			generatedAt,
		});

		expect(manifest).not.toHaveProperty('zip');
		expect(manifest.files).toContainEqual({
			path: 'missing/audio',
			category: 'audio',
			order: 0,
			missingReason: 'Missing audio',
		});
		expect(manifest.files).toContainEqual({
			path: 'subtitle/empty.srt',
			category: 'subtitle',
			order: 1,
			missingReason: 'Missing file',
		});
	});

	it('keeps checksums and marks files that omit them', () => {
		const files = completeFiles().map((entry) => {
			if (entry.path !== 'layers/bg.png') {
				return entry;
			}

			return file(entry.path, entry.category, entry.order, {
				url: 'https://cdn.example.com/bg.png?X-Amz-Signature=secret-token',
			});
		});

		const manifest = buildDeliveryManifest({
			projectId: 'project-1',
			project: createComicProject(),
			batches: batches(),
			files,
			generatedAt,
		});
		const layer = manifest.files.find(
			(entry) => entry.path === 'layers/bg.png',
		);
		const source = manifest.files.find(
			(entry) => entry.path === 'source/page.png',
		);

		expect(source?.checksum).toBe('sum-source');
		expect(source?.missingReason).toBeUndefined();
		expect(layer).toMatchObject({
			url: 'https://cdn.example.com/bg.png?X-Amz-Signature=secret-token',
			missingReason: 'Missing checksum',
		});
		expect(layer?.checksum).toBeUndefined();
	});

	it('orders playback by batch index and keeps a missing batch in sequence', () => {
		const files = completeFiles().filter((entry) => entry.order !== 2);
		const manifest = buildDeliveryManifest({
			projectId: 'project-1',
			project: createComicProject(),
			batches: batches(),
			files,
			generatedAt,
		});

		expect(manifest.playOrder).toEqual([
			'videos/first.mp4',
			'final-video/batch-b.mp4',
		]);
		expect(manifest.batches.map((batch) => batch.batchId)).toEqual([
			'batch-a',
			'batch-b',
		]);
		expect(manifest.files).toContainEqual({
			path: 'final-video/batch-b.mp4',
			category: 'final-video',
			order: 2,
			missingReason: 'Missing final video for batch batch-b',
		});
	});

	it('hashes project content and leaves the input unchanged', () => {
		const project = createComicProject();
		const sourceFiles = completeFiles();
		const sourceBatches = batches();
		const before = structuredClone({
			project,
			files: sourceFiles,
			batches: sourceBatches,
		});

		const manifest = buildDeliveryManifest({
			projectId: 'project-1',
			project,
			batches: sourceBatches,
			files: sourceFiles,
			generatedAt,
		});
		const changed = buildDeliveryManifest({
			projectId: 'project-1',
			project: {...project, fps: project.fps + 1},
			batches: sourceBatches,
			files: sourceFiles,
			generatedAt,
		});

		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.projectId).toBe('project-1');
		expect(manifest.generatedAt).toBe(generatedAt);
		expect(manifest.projectContentHash).toBe(projectContentHash(project));
		expect(manifest.projectContentHash).not.toBe(changed.projectContentHash);
		expect({project, files: sourceFiles, batches: sourceBatches}).toEqual(
			before,
		);
	});
});
