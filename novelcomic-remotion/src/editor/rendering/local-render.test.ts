import {afterEach, describe, expect, it, vi} from 'vitest';
import {POST as renderBatchesRoute} from '../../../app/api/compose/project/render-batches/route';
import {POST as progressRoute} from '../../../app/api/progress/route';
import {POST as renderRoute} from '../../../app/api/render/route';
import type {ImageAsset} from '../assets/assets';
import {appendImageSequence} from '../comic/append-image-sequence';
import {createComicProject} from '../compose/build-state';
import type {ImageItem} from '../items/image/image-item-type';
import type {RenderVideoPayload} from './types';

const renderMediaLocal = vi.hoisted(() => vi.fn());
const renderMediaOnLambda = vi.hoisted(() =>
	vi.fn(async () => {
		return {bucketName: 'aws-bucket', renderId: 'lambda-1'};
	}),
);

vi.mock('./render-media-local', () => {
	return {renderMediaLocal};
});

vi.mock('@remotion/lambda/client', () => {
	return {
		renderMediaOnLambda,
		speculateFunctionName: () => 'function-name',
		getRenderProgress: vi.fn(),
	};
});

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

const imageItem = (durationInFrames: number): ImageItem => {
	return {
		id: 'image-1',
		type: 'image',
		assetId: 'asset-main',
		durationInFrames,
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

const renderPayload = (
	extra: Partial<RenderVideoPayload> = {},
): RenderVideoPayload => {
	const item = imageItem(30);
	return {
		compositionWidth: 1080,
		compositionHeight: 1920,
		fps: 30,
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
		...extra,
	};
};

const post = async (
	route: (request: Request) => Promise<Response>,
	url: string,
	body: unknown,
) => {
	const response = await route(
		new Request(url, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}),
	);
	const json = (await response.json()) as Record<string, unknown>;
	return {response, json};
};

describe('local renderMedia', () => {
	const originalBackend = process.env.REMOTION_RENDER_BACKEND;

	afterEach(() => {
		renderMediaLocal.mockReset();
		renderMediaOnLambda.mockClear();
		if (originalBackend === undefined) {
			delete process.env.REMOTION_RENDER_BACKEND;
		} else {
			process.env.REMOTION_RENDER_BACKEND = originalBackend;
		}
	});

	it('returns a local render id before renderMedia finishes', async () => {
		process.env.REMOTION_RENDER_BACKEND = 'local';
		let finish: (value: {
			outputFile: string;
			outputSizeInBytes: number;
			outputName: string;
		}) => void = () => undefined;
		renderMediaLocal.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);

		const submitted = await post(
			renderRoute,
			'https://editor.local/api/render',
			renderPayload({frameRange: [0, 10]}),
		);
		expect(submitted.response.status).toBe(200);
		expect(submitted.json).toMatchObject({
			type: 'success',
			bucketName: 'local',
		});
		expect(submitted.json.renderId).toEqual(expect.any(String));
		expect(renderMediaOnLambda).not.toHaveBeenCalled();

		const pending = await post(
			progressRoute,
			'https://editor.local/api/progress',
			{
				bucketName: 'local',
				renderId: submitted.json.renderId,
			},
		);
		expect(pending.json).toMatchObject({
			type: 'in-progress',
			overallProgress: 0,
		});

		finish({
			outputFile: 'https://cdn.example.com/renders/demo.mp4',
			outputSizeInBytes: 4,
			outputName: 'demo.mp4',
		});
		await vi.waitFor(async () => {
			const done = await post(
				progressRoute,
				'https://editor.local/api/progress',
				{
					bucketName: 'local',
					renderId: submitted.json.renderId,
				},
			);
			expect(done.json).toEqual({
				type: 'done',
				outputFile: 'https://cdn.example.com/renders/demo.mp4',
				outputSizeInBytes: 4,
				outputName: 'demo.mp4',
			});
		});
		expect(renderMediaLocal).toHaveBeenCalledWith(
			expect.objectContaining({
				renderId: submitted.json.renderId,
				payload: expect.objectContaining({frameRange: [0, 10]}),
			}),
		);
	});

	it('returns batch render ids immediately on the local backend', async () => {
		process.env.REMOTION_RENDER_BACKEND = 'local';
		renderMediaLocal.mockImplementation(() => new Promise(() => undefined));
		const project = appendImageSequence(createComicProject(), {
			allowedHosts: ['cdn.example.com'],
			images: [
				{
					shotId: 'shot-1',
					url: 'https://cdn.example.com/wide.png',
					width: 1920,
					height: 1080,
					durationInFrames: 150,
				},
			],
		});
		const submitted = await post(
			renderBatchesRoute,
			'https://editor.local/api/compose/project/render-batches',
			{project},
		);
		expect(submitted.response.status).toBe(200);
		const results = submitted.json.results as Array<{
			ok: boolean;
			bucketName: string;
			renderId: string;
		}>;
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ok: true, bucketName: 'local'});
		expect(results[0]?.renderId).toEqual(expect.any(String));
		expect(renderMediaOnLambda).not.toHaveBeenCalled();
		expect(renderMediaLocal).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({frameRange: [0, 149]}),
			}),
		);
	});

	it('keeps lambda submission off the local bucket when the backend is unset', async () => {
		delete process.env.REMOTION_RENDER_BACKEND;
		const submitted = await post(
			renderRoute,
			'https://editor.local/api/render',
			renderPayload(),
		);
		expect(renderMediaLocal).not.toHaveBeenCalled();
		if (submitted.response.status === 200) {
			expect(submitted.json).toMatchObject({
				type: 'success',
				bucketName: 'aws-bucket',
				renderId: 'lambda-1',
			});
			return;
		}

		expect(submitted.response.status).toBe(400);
		expect(submitted.json.error).toEqual(expect.stringMatching(/REMOTION_AWS/));
	});
});
