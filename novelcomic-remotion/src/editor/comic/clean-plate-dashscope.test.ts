import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {putCOSObject, getCOSReadUrl} = vi.hoisted(() => ({
	putCOSObject: vi.fn(async () => undefined),
	getCOSReadUrl: vi.fn((key: string) => `https://cdn.example.com/${key}`),
}));

vi.mock('../utils/cos-client', () => ({putCOSObject, getCOSReadUrl}));

import {POST as inpaintRoute} from '../../../app/api/compose/layers/inpaint/route';

const png512 = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44,
	0x52, 0, 0, 2, 0, 0, 0, 2, 0,
]);

describe('Alibaba Bailian clean plate adapter', () => {
	const original = {
		allowedHosts: process.env.COMIC_ALLOWED_REMOTE_HOSTS,
		serviceUrl: process.env.COMIC_INPAINT_SERVICE_URL,
		apiKey: process.env.DASHSCOPE_API_KEY,
		pollInterval: process.env.DASHSCOPE_IMAGE_EDIT_POLL_INTERVAL_MS,
	};

	beforeEach(() => {
		process.env.COMIC_ALLOWED_REMOTE_HOSTS = 'cdn.example.com';
		delete process.env.COMIC_INPAINT_SERVICE_URL;
		process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';
		process.env.DASHSCOPE_IMAGE_EDIT_POLL_INTERVAL_MS = '0';
		putCOSObject.mockClear();
		getCOSReadUrl.mockClear();
	});

	afterEach(() => {
		for (const [key, value] of Object.entries({
			COMIC_ALLOWED_REMOTE_HOSTS: original.allowedHosts,
			COMIC_INPAINT_SERVICE_URL: original.serviceUrl,
			DASHSCOPE_API_KEY: original.apiKey,
			DASHSCOPE_IMAGE_EDIT_POLL_INTERVAL_MS: original.pollInterval,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('runs an async edit task and persists the generated image', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({output: {task_id: 'task-123'}}))
			.mockResolvedValueOnce(
				Response.json({
					output: {
						task_status: 'SUCCEEDED',
						results: [{url: 'https://provider.example.com/result.png'}],
					},
				}),
			)
			.mockResolvedValueOnce(
				new Response(png512, {
					status: 200,
					headers: {'content-type': 'image/png'},
				}),
			);
		vi.stubGlobal('fetch', fetchMock);

		const response = await inpaintRoute(
			new Request('https://editor.local/api/compose/layers/inpaint', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({
					projectId: 'project-1',
					shotId: 'shot-1',
					sourceAssetId: 'asset-source',
					maskAssetId: 'asset-mask',
					sourceUrl: 'https://cdn.example.com/source.png',
					maskUrl: 'https://cdn.example.com/mask.png',
					canvas: {width: 512, height: 512},
					mode: 'ai-inpaint',
					version: 1,
					clientRequestId: 'request-1',
				}),
			}),
		);
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			type: 'success',
			cleanPlateAsset: {
				remoteUrl:
					'https://cdn.example.com/comic/inpaint/project-1/shot-1/request-1.png',
				width: 512,
				height: 512,
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation',
		);
		expect(
			JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
		).toMatchObject({
			model: 'wanx2.1-imageedit',
			input: {
				function: 'description_edit_with_mask',
				base_image_url: 'https://cdn.example.com/source.png',
				mask_image_url: 'https://cdn.example.com/mask.png',
			},
		});
		expect(putCOSObject).toHaveBeenCalledWith(
			expect.objectContaining({
				key: 'comic/inpaint/project-1/shot-1/request-1.png',
			}),
		);
	});
});
