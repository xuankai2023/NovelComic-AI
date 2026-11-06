import {afterEach, describe, expect, it, vi} from 'vitest';

const mergeBatchVideos = vi.hoisted(() =>
	vi.fn(async () => ({
		file: {
			path: 'final-video/full.mp4',
			category: 'final-video' as const,
			order: 0,
			url: 'https://delivery.example.com/full.mp4',
			checksum: 'checksum',
			sizeBytes: 12,
		},
		batchIds: ['batch-a'],
	})),
);

vi.mock('../comic/merge-batches', () => ({
	mergeBatchVideos,
}));

import {POST as mergeRoute} from '../../../app/api/compose/project/merge-batches/route';
import {createComicProject} from '../compose/build-state';

const originalAllowedHosts = process.env.COMIC_ALLOWED_REMOTE_HOSTS;

const batch = {
	batchId: 'batch-a',
	batchIndex: 1,
	fromFrame: 0,
	endFrameInclusive: 149,
	durationInFrames: 150,
	shotIds: ['shot-a'],
	reason: 'target-range',
};

const post = async (body: unknown) => {
	const response = await mergeRoute(
		new Request('https://editor.local/api/compose/project/merge-batches', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}),
	);
	return {
		response,
		json: (await response.json()) as Record<string, unknown>,
	};
};

describe('merge batches route', () => {
	afterEach(() => {
		mergeBatchVideos.mockClear();
		if (originalAllowedHosts === undefined) {
			delete process.env.COMIC_ALLOWED_REMOTE_HOSTS;
		} else {
			process.env.COMIC_ALLOWED_REMOTE_HOSTS = originalAllowedHosts;
		}
	});

	it('validates render URLs and returns the merged video file', async () => {
		process.env.COMIC_ALLOWED_REMOTE_HOSTS = 'cdn.example.com';
		const result = await post({
			projectId: 'project-1',
			project: createComicProject(),
			batches: [batch],
			renderedBatches: [
				{
					batchId: 'batch-a',
					status: 'done',
					outputFile: 'https://cdn.example.com/a.mp4',
				},
			],
		});

		expect(result.response.status).toBe(200);
		expect(result.json).toMatchObject({
			type: 'success',
			file: {path: 'final-video/full.mp4'},
			batchIds: ['batch-a'],
		});
		expect(mergeBatchVideos).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: 'project-1',
				batches: [batch],
				renderedBatches: [
					expect.objectContaining({
						outputFile: 'https://cdn.example.com/a.mp4',
					}),
				],
			}),
		);
	});

	it('rejects a render URL outside the configured allowlist', async () => {
		process.env.COMIC_ALLOWED_REMOTE_HOSTS = 'cdn.example.com';

		const result = await post({
			projectId: 'project-1',
			project: createComicProject(),
			batches: [batch],
			renderedBatches: [
				{
					batchId: 'batch-a',
					status: 'done',
					outputFile: 'https://untrusted.example.com/a.mp4',
				},
			],
		});

		expect(result.response.status).toBe(422);
		expect(result.json).toMatchObject({
			type: 'error',
			code: 'INVALID_REMOTE_URL',
		});
		expect(mergeBatchVideos).not.toHaveBeenCalled();
	});
});
