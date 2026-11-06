import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {describe, expect, it, vi} from 'vitest';
import {createComicProject} from '../compose/build-state';
import type {FinalizedBatchRender} from './finalize-batches';
import {mergeBatchVideos} from './merge-batches';
import type {OutputBatch} from './types';

const batch = (
	batchId: string,
	batchIndex: number,
	fromFrame: number,
): OutputBatch => ({
	batchId,
	batchIndex,
	fromFrame,
	endFrameInclusive: fromFrame + 149,
	durationInFrames: 150,
	shotIds: [`shot-${batchIndex}`],
	reason: 'target-range',
});

const done = (
	batchId: string,
	outputFile: string,
): FinalizedBatchRender => ({
	batchId,
	status: 'done',
	outputFile,
});

describe('mergeBatchVideos', () => {
	it('merges completed batches in batch order and uploads one final video', async () => {
		const uploads: Array<{key: string; body: Buffer; contentType: string}> = [];
		const download = vi.fn(async (url: string) => Buffer.from(`source:${url}`));
		const runFfmpeg = vi.fn(async (inputPaths: readonly string[], outputPath: string) => {
			expect(inputPaths).toHaveLength(2);
			await writeFile(outputPath, Buffer.from('merged-video'));
		});

		const result = await mergeBatchVideos(
			{
				projectId: 'project/1',
				project: createComicProject(),
				batches: [batch('batch-b', 2, 150), batch('batch-a', 1, 0)],
				renderedBatches: [
					done('batch-b', 'https://cdn.example.com/b.mp4'),
					done('batch-a', 'https://cdn.example.com/a.mp4'),
				],
			},
			{
				download,
				runFfmpeg,
				upload: async (input) => {
					uploads.push(input);
				},
				readUrl: (key) => `https://delivery.example.com/${key}`,
			},
		);

		expect(download.mock.calls.map(([url]) => url)).toEqual([
			'https://cdn.example.com/a.mp4',
			'https://cdn.example.com/b.mp4',
		]);
		expect(runFfmpeg).toHaveBeenCalledOnce();
		expect(uploads).toHaveLength(1);
		expect(uploads[0]).toMatchObject({
			contentType: 'video/mp4',
			body: Buffer.from('merged-video'),
		});
		expect(result).toMatchObject({
			file: {
				path: 'final-video/full.mp4',
				category: 'final-video',
				order: 0,
				url: expect.stringMatching(
					/^https:\/\/delivery\.example\.com\/deliveries\/project-1\/.+\/final-video\/full\.mp4$/,
				),
				sizeBytes: 12,
				checksum: createHash('sha256')
					.update('merged-video')
					.digest('hex'),
			},
			batchIds: ['batch-a', 'batch-b'],
		});
	});

	it('rejects a plan with a missing or incomplete batch render', async () => {
		await expect(
			mergeBatchVideos({
				projectId: 'project-1',
				project: createComicProject(),
				batches: [batch('batch-a', 1, 0), batch('batch-b', 2, 150)],
				renderedBatches: [done('batch-a', 'https://cdn.example.com/a.mp4')],
			}),
		).rejects.toThrow('Batch batch-b has no completed render result');

		await expect(
			mergeBatchVideos({
				projectId: 'project-1',
				project: createComicProject(),
				batches: [batch('batch-a', 1, 0)],
				renderedBatches: [
					{
						batchId: 'batch-a',
						status: 'in-progress',
					},
				],
			}),
		).rejects.toThrow('Batch batch-a is still rendering');
	});

	it('rejects non-HTTPS render outputs before downloading them', async () => {
		const download = vi.fn();

		await expect(
			mergeBatchVideos(
				{
					projectId: 'project-1',
					project: createComicProject(),
					batches: [batch('batch-a', 1, 0)],
					renderedBatches: [done('batch-a', 'http://cdn.example.com/a.mp4')],
				},
				{download},
			),
		).rejects.toThrow('Batch batch-a output file must use HTTPS');
		expect(download).not.toHaveBeenCalled();
	});
});
