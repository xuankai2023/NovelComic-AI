import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {POST as inpaintRoute} from '../../../app/api/compose/layers/inpaint/route';

const originalAllowedHosts = process.env.COMIC_ALLOWED_REMOTE_HOSTS;
const originalServiceUrl = process.env.COMIC_INPAINT_SERVICE_URL;
const originalApiKey = process.env.COMIC_INPAINT_API_KEY;

const restoreEnv = () => {
	if (originalAllowedHosts === undefined) {
		delete process.env.COMIC_ALLOWED_REMOTE_HOSTS;
	} else {
		process.env.COMIC_ALLOWED_REMOTE_HOSTS = originalAllowedHosts;
	}

	if (originalServiceUrl === undefined) {
		delete process.env.COMIC_INPAINT_SERVICE_URL;
	} else {
		process.env.COMIC_INPAINT_SERVICE_URL = originalServiceUrl;
	}

	if (originalApiKey === undefined) {
		delete process.env.COMIC_INPAINT_API_KEY;
	} else {
		process.env.COMIC_INPAINT_API_KEY = originalApiKey;
	}
};

const post = async (body: unknown) => {
	const response = await inpaintRoute(
		new Request('https://editor.local/api/compose/layers/inpaint', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}),
	);
	const json = (await response.json()) as Record<string, unknown>;
	return {response, json};
};

const requestBody = () => {
	return {
		projectId: 'project-1',
		shotId: 'shot-1',
		sourceAssetId: 'asset-source',
		maskAssetId: 'asset-mask',
		sourceUrl: 'https://cdn.example.com/source.png',
		maskUrl: 'https://cdn.example.com/mask.png',
		canvas: {width: 1080, height: 1920},
		mode: 'ai-inpaint',
		version: 1,
		clientRequestId: 'req-1',
	};
};

describe('clean plate inpaint route', () => {
	beforeEach(() => {
		process.env.COMIC_ALLOWED_REMOTE_HOSTS = 'cdn.example.com';
		process.env.COMIC_INPAINT_SERVICE_URL = 'https://inpaint.example.com/api';
		process.env.COMIC_INPAINT_API_KEY = 'secret-token';
	});

	afterEach(() => {
		restoreEnv();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('submits a strict mask inpaint request and returns a clean plate asset', async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			expect(url).toBe('https://inpaint.example.com/api/inpaint');
			expect(init?.method).toBe('POST');
			expect((init?.headers as Record<string, string>).authorization).toBe(
				'Bearer secret-token',
			);
			expect(JSON.parse(String(init?.body))).toMatchObject({
				projectId: 'project-1',
				shotId: 'shot-1',
				sourceAssetId: 'asset-source',
				maskAssetId: 'asset-mask',
				sourceUrl: 'https://cdn.example.com/source.png',
				maskUrl: 'https://cdn.example.com/mask.png',
				mode: 'ai-inpaint',
				version: 1,
				clientRequestId: 'req-1',
			});

			return Response.json({
				cleanPlateAsset: {
					id: 'asset-clean',
					type: 'image',
					filename: 'clean.png',
					size: 1234,
					remoteUrl: 'https://cdn.example.com/clean.png',
					remoteFileKey: 'clean.png',
					mimeType: 'image/png',
					width: 1080,
					height: 1920,
				},
				diagnostics: {
					alphaHoleRatio: 0,
					edgeArtifactScore: 0.02,
					recompositionScore: 0.03,
					warnings: ['soft-edge'],
				},
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await post(requestBody());

		expect(result.response.status).toBe(200);
		expect(result.json).toMatchObject({
			type: 'success',
			cleanPlateAsset: {
				id: 'asset-clean',
				type: 'image',
				remoteUrl: 'https://cdn.example.com/clean.png',
				width: 1080,
				height: 1920,
			},
			diagnostics: {
				alphaHoleRatio: 0,
				edgeArtifactScore: 0.02,
				recompositionScore: 0.03,
				warnings: ['soft-edge'],
			},
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('fails fast when service or trusted URLs are invalid', async () => {
		delete process.env.COMIC_INPAINT_SERVICE_URL;
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const missingService = await post(requestBody());
		expect(missingService.response.status).toBe(503);
		expect(missingService.json).toMatchObject({
			type: 'error',
			code: 'DEPENDENCY_UNAVAILABLE',
			retryable: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();

		process.env.COMIC_INPAINT_SERVICE_URL = 'https://inpaint.example.com/api';
		const untrusted = await post({
			...requestBody(),
			maskUrl: 'https://evil.example.com/mask.png',
		});
		expect(untrusted.response.status).toBe(422);
		expect(untrusted.json).toMatchObject({code: 'INVALID_REMOTE_URL'});
	});

	it('rejects clean plates that do not match the source canvas', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				return Response.json({
					cleanPlateAsset: {
						id: 'asset-clean',
						type: 'image',
						filename: 'clean.png',
						size: 1234,
						remoteUrl: 'https://cdn.example.com/clean.png',
						remoteFileKey: null,
						mimeType: 'image/png',
						width: 100,
						height: 100,
					},
					diagnostics: {
						alphaHoleRatio: 0,
						edgeArtifactScore: 0,
						recompositionScore: 0,
						warnings: [],
					},
				});
			}),
		);

		const result = await post(requestBody());

		expect(result.response.status).toBe(422);
		expect(result.json).toMatchObject({
			type: 'error',
			code: 'DOMAIN_INVARIANT',
			message: 'Clean plate dimensions must match the source canvas',
		});
	});

	it('rejects clone points outside the source canvas before calling the service', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const result = await post({
			...requestBody(),
			mode: 'clone-fill',
			cloneSource: {x: 1080, y: 20},
		});

		expect(result.response.status).toBe(422);
		expect(result.json).toMatchObject({
			type: 'error',
			code: 'DOMAIN_INVARIANT',
			message: 'Clone source must be inside the source canvas',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects out-of-range diagnostics from the inpaint service', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				return Response.json({
					cleanPlateAsset: {
						id: 'asset-clean',
						type: 'image',
						filename: 'clean.png',
						size: 1234,
						remoteUrl: 'https://cdn.example.com/clean.png',
						remoteFileKey: null,
						mimeType: 'image/png',
						width: 1080,
						height: 1920,
					},
					diagnostics: {
						alphaHoleRatio: 1.4,
						edgeArtifactScore: 0,
						recompositionScore: 0,
						warnings: [],
					},
				});
			}),
		);

		const result = await post(requestBody());

		expect(result.response.status).toBe(422);
		expect(result.json).toMatchObject({
			type: 'error',
			code: 'DOMAIN_INVARIANT',
			message: 'Inpaint response alphaHoleRatio must be between 0 and 1',
		});
	});
});
