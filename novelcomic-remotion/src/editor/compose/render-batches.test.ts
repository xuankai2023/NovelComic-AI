import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import type {OutputBatch} from '../comic/types';
import type {ImageItem} from '../items/image/image-item-type';
import type {RenderVideoPayload} from '../rendering/types';
import {createComicProject} from './build-state';
import {renderBatches, type BatchRenderSubmitter} from './render-batches';

const imageAsset = (id: string): ImageAsset => {
	return {
		id,
		type: 'image',
		filename: `${id}.png`,
		size: 1,
		remoteUrl: `https://cdn.example.com/${id}.png`,
		remoteFileKey: null,
		mimeType: 'image/png',
		width: 100,
		height: 100,
	};
};

const imageItem = (): ImageItem => {
	return {
		id: 'image-1',
		type: 'image',
		assetId: 'asset-main',
		durationInFrames: 900,
		from: 0,
		top: 0,
		left: 0,
		width: 100,
		height: 100,
		opacity: 1,
		isDraggingInTimeline: false,
		borderRadius: 0,
		rotation: 0,
		keepAspectRatio: true,
		fadeInDurationInSeconds: 0,
		fadeOutDurationInSeconds: 0,
		cropLeft: 0,
		cropTop: 0,
		cropRight: 0,
		cropBottom: 0,
	};
};

const project = () => {
	const item = imageItem();
	return {
		...createComicProject(),
		tracks: [
			{
				id: 'track-1',
				items: [item.id],
				hidden: false,
				muted: false,
			},
		],
		items: {[item.id]: item},
		assets: {'asset-main': imageAsset('asset-main')},
	};
};

const batch = (
	batchId: string,
	batchIndex: number,
	fromFrame: number,
	durationInFrames: number,
): OutputBatch => {
	return {
		batchId,
		batchIndex,
		fromFrame,
		endFrameInclusive: fromFrame + durationInFrames - 1,
		durationInFrames,
		shotIds: [`shot-${batchIndex}`],
		reason: 'target-range',
	};
};

describe('renderBatches', () => {
	it('submits every batch and continues after one failure', async () => {
		const calls: RenderVideoPayload[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const submit: BatchRenderSubmitter = async (payload) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			calls.push(payload);
			await new Promise((resolve) => {
				setTimeout(resolve, 0);
			});
			inFlight -= 1;
			if (payload.frameRange?.[0] === 450) {
				throw new Error('lambda unavailable');
			}

			return {
				renderId: `render-${payload.frameRange?.[0]}`,
				bucketName: 'comic-bucket',
			};
		};

		const source = project();
		const snapshot = structuredClone(source);
		const results = await renderBatches({
			project: source,
			batches: [batch('batch-b', 2, 450, 150), batch('batch-a', 1, 0, 450)],
			submit,
		});

		expect(source).toEqual(snapshot);
		expect(maxInFlight).toBe(1);
		expect(calls.map((entry) => entry.frameRange)).toEqual([
			[0, 449],
			[450, 599],
		]);
		expect(calls.every((entry) => entry.enforceBatchDuration)).toBe(true);
		expect(results).toEqual([
			{
				batchId: 'batch-a',
				ok: true,
				renderId: 'render-0',
				bucketName: 'comic-bucket',
			},
			{
				batchId: 'batch-b',
				ok: false,
				error: expect.objectContaining({
					code: 'DEPENDENCY_UNAVAILABLE',
					retryable: true,
					message: 'lambda unavailable',
				}),
			},
		]);
	});

	it('submits only the requested retry batches', async () => {
		const calls: Array<RenderVideoPayload['frameRange']> = [];
		const submit: BatchRenderSubmitter = async (payload) => {
			calls.push(payload.frameRange);
			return {renderId: 'retry-render', bucketName: 'comic-bucket'};
		};

		const results = await renderBatches({
			project: project(),
			batches: [batch('batch-a', 1, 0, 450), batch('batch-b', 2, 450, 150)],
			retryBatchIds: ['missing', 'batch-b'],
			submit,
		});

		expect(calls).toEqual([[450, 599]]);
		expect(results).toEqual([
			{
				batchId: 'batch-b',
				ok: true,
				renderId: 'retry-render',
				bucketName: 'comic-bucket',
			},
		]);
	});

	it('records an invalid batch without submitting it or blocking the next one', async () => {
		const calls: string[] = [];
		const submit: BatchRenderSubmitter = async (payload) => {
			calls.push(payload.frameRange?.join(':') ?? '');
			return {renderId: 'ok', bucketName: 'comic-bucket'};
		};

		const results = await renderBatches({
			project: project(),
			batches: [batch('too-short', 1, 0, 120), batch('ok-batch', 2, 120, 150)],
			submit,
		});

		expect(calls).toEqual(['120:269']);
		expect(results[0]).toMatchObject({
			batchId: 'too-short',
			ok: false,
			error: expect.objectContaining({
				code: 'DOMAIN_INVARIANT',
				retryable: false,
			}),
		});
		expect(results[1]).toMatchObject({
			batchId: 'ok-batch',
			ok: true,
			renderId: 'ok',
		});
	});
});
