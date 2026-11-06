import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {finalizeBatchDelivery} from './finalize-batches';
import type {DeliveryFileEntry, OutputBatch} from './types';

const generatedAt = '2026-10-03T00:00:00.000Z';

const batch = (
	batchId: string,
	batchIndex: number,
	fromFrame: number,
): OutputBatch => {
	return {
		batchId,
		batchIndex,
		fromFrame,
		endFrameInclusive: fromFrame + 149,
		durationInFrames: 150,
		shotIds: [`shot-${batchIndex}`],
		reason: 'target-range',
	};
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

describe('finalizeBatchDelivery', () => {
	it('turns completed batch outputs into a stable play order', () => {
		const result = finalizeBatchDelivery({
			projectId: 'project-1',
			project: createComicProject(),
			batches: [batch('batch-b', 2, 150), batch('batch-a', 1, 0)],
			renderedBatches: [
				{
					batchId: 'batch-b',
					status: 'done',
					outputFile: 'https://cdn.example.com/renders/b.mp4',
					outputSizeInBytes: 20,
					checksum: 'sum-b',
				},
				{
					batchId: 'batch-a',
					status: 'done',
					outputFile: 'https://cdn.example.com/renders/a.mp4',
					outputSizeInBytes: 10,
					checksum: 'sum-a',
				},
			],
			files: [
				file('videos/old.mp4', 'final-video', 1, {
					url: 'https://cdn.example.com/old.mp4',
				}),
				file('source/page.png', 'source', 0, {
					url: 'https://cdn.example.com/page.png',
					checksum: 'sum-source',
				}),
			],
			generatedAt,
		});

		expect(result.incompleteBatches).toEqual([]);
		expect(result.finalVideoFiles).toEqual([
			{
				path: 'final-video/batch-a.mp4',
				category: 'final-video',
				order: 1,
				url: 'https://cdn.example.com/renders/a.mp4',
				sizeBytes: 10,
				checksum: 'sum-a',
			},
			{
				path: 'final-video/batch-b.mp4',
				category: 'final-video',
				order: 2,
				url: 'https://cdn.example.com/renders/b.mp4',
				sizeBytes: 20,
				checksum: 'sum-b',
			},
		]);
		expect(result.playOrder).toEqual([
			'final-video/batch-a.mp4',
			'final-video/batch-b.mp4',
		]);
		expect(result.manifest.playOrder).toEqual(result.playOrder);
		expect(
			result.manifest.files.some((entry) => entry.path === 'videos/old.mp4'),
		).toBe(false);
	});

	it('keeps missing and failed batches retryable without losing sequence', () => {
		const result = finalizeBatchDelivery({
			projectId: 'project-1',
			project: createComicProject(),
			batches: [
				batch('batch-a', 1, 0),
				batch('batch-b', 2, 150),
				batch('batch-c', 3, 300),
			],
			renderedBatches: [
				{
					batchId: 'batch-a',
					status: 'done',
					outputFile: 'https://cdn.example.com/renders/a.mp4',
				},
				{
					batchId: 'batch-b',
					status: 'error',
					error: 'render failed',
				},
			],
			generatedAt,
		});

		expect(result.incompleteBatches).toEqual([
			{
				batchId: 'batch-b',
				batchIndex: 2,
				status: 'error',
				retryable: true,
				message: 'render failed',
			},
			{
				batchId: 'batch-c',
				batchIndex: 3,
				status: 'missing',
				retryable: true,
				message: 'Batch batch-c has no render result',
			},
		]);
		expect(result.playOrder).toEqual([
			'final-video/batch-a.mp4',
			'final-video/batch-b.mp4',
			'final-video/batch-c.mp4',
		]);
		expect(result.manifest.files).toContainEqual({
			path: 'final-video/batch-b.mp4',
			category: 'final-video',
			order: 2,
			missingReason: 'Missing final video for batch batch-b',
		});
		expect(result.manifest.files).toContainEqual({
			path: 'final-video/batch-c.mp4',
			category: 'final-video',
			order: 3,
			missingReason: 'Missing final video for batch batch-c',
		});
	});

	it('rejects rendered batches that do not belong to the plan', () => {
		expect(() => {
			finalizeBatchDelivery({
				projectId: 'project-1',
				project: createComicProject(),
				batches: [batch('batch-a', 1, 0)],
				renderedBatches: [
					{
						batchId: 'batch-x',
						status: 'done',
						outputFile: 'https://cdn.example.com/renders/x.mp4',
					},
				],
				generatedAt,
			});
		}).toThrow('Rendered batch batch-x is unknown');
	});
});

