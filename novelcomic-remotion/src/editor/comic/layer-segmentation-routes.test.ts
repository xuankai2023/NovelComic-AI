import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {POST as requestSegmentationRoute} from '../../../app/api/compose/layers/request-segmentation/route';
import {POST as segmentationStatusRoute} from '../../../app/api/compose/layers/segmentation-status/route';
import type {LayerPackage} from './types';

const originalAllowedHosts = process.env.COMIC_ALLOWED_REMOTE_HOSTS;
const originalServiceUrl = process.env.COMIC_SEGMENTATION_SERVICE_URL;
const originalApiKey = process.env.COMIC_SEGMENTATION_API_KEY;

const post = async (
	route: (request: Request) => Promise<Response>,
	path: string,
	body: unknown,
) => {
	const response = await route(
		new Request(`https://editor.local/api/compose/${path}`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}),
	);
	const json = (await response.json()) as Record<string, unknown>;
	return {response, json};
};

const restoreEnv = () => {
	if (originalAllowedHosts === undefined) {
		delete process.env.COMIC_ALLOWED_REMOTE_HOSTS;
	} else {
		process.env.COMIC_ALLOWED_REMOTE_HOSTS = originalAllowedHosts;
	}

	if (originalServiceUrl === undefined) {
		delete process.env.COMIC_SEGMENTATION_SERVICE_URL;
	} else {
		process.env.COMIC_SEGMENTATION_SERVICE_URL = originalServiceUrl;
	}

	if (originalApiKey === undefined) {
		delete process.env.COMIC_SEGMENTATION_API_KEY;
	} else {
		process.env.COMIC_SEGMENTATION_API_KEY = originalApiKey;
	}
};

const layerPackage = (): LayerPackage => {
	return {
		schemaVersion: 1,
		projectId: 'project-1',
		shotId: 'shot-1',
		sourceUrl: 'https://cdn.example.com/source.png',
		canvas: {width: 1080, height: 1920},
		layers: [
			{
				layerId: 'clean-plate',
				name: 'clean plate',
				semantic: 'background',
				imageUrl: 'https://cdn.example.com/clean-plate.png',
				zIndex: 0,
				visible: true,
				bounds: {x: 0, y: 0, width: 1080, height: 1920},
				anchor: {x: 0.5, y: 0.5},
				confidence: 0.98,
				motionPolicy: 'static',
			},
			{
				layerId: 'hair',
				name: 'hair',
				semantic: 'hair',
				imageUrl: 'https://cdn.example.com/hair.png',
				zIndex: 10,
				visible: true,
				bounds: {x: 120, y: 80, width: 480, height: 420},
				anchor: {x: 0.5, y: 0},
				confidence: 0.92,
				motionPolicy: 'subtle',
			},
		],
		diagnostics: {
			recompositionScore: 0.02,
			alphaHoleRatio: 0.01,
			edgeArtifactScore: 0.03,
			requiresFallback: false,
			warnings: [],
		},
	};
};

describe('layer segmentation compose routes', () => {
	beforeEach(() => {
		process.env.COMIC_ALLOWED_REMOTE_HOSTS = 'cdn.example.com';
		process.env.COMIC_SEGMENTATION_SERVICE_URL =
			'https://segmenter.example.com/api';
		process.env.COMIC_SEGMENTATION_API_KEY = 'secret-token';
	});

	afterEach(() => {
		restoreEnv();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('submits a segmentation task to the configured external service', async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			expect(url).toBe('https://segmenter.example.com/api/segmentations');
			expect(init?.method).toBe('POST');
			expect((init?.headers as Record<string, string>).authorization).toBe(
				'Bearer secret-token',
			);
			expect(JSON.parse(String(init?.body))).toMatchObject({
				projectId: 'project-1',
				shotId: 'shot-1',
				sourceUrl: 'https://cdn.example.com/source.png',
				canvas: {width: 1080, height: 1920},
				semanticHints: ['hair', 'mouth-open'],
			});

			return Response.json({
				jobId: 'seg-job-1',
				status: 'running',
				progress: 0.25,
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await post(
			requestSegmentationRoute,
			'layers/request-segmentation',
			{
				projectId: 'project-1',
				shotId: 'shot-1',
				sourceUrl: 'https://cdn.example.com/source.png',
				canvas: {width: 1080, height: 1920},
				semanticHints: ['hair', 'mouth-open'],
			},
		);

		expect(result.response.status).toBe(200);
		expect(result.json.task).toEqual({
			jobId: 'seg-job-1',
			status: 'running',
			progress: 0.25,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('returns a validated LayerPackage when the segmentation job is done', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				expect(url).toBe(
					'https://segmenter.example.com/api/segmentations/seg-job-1',
				);
				expect(init?.method).toBe('GET');
				return Response.json({
					jobId: 'seg-job-1',
					status: 'done',
					layerPackage: layerPackage(),
				});
			}),
		);

		const result = await post(
			segmentationStatusRoute,
			'layers/segmentation-status',
			{jobId: 'seg-job-1'},
		);

		expect(result.response.status).toBe(200);
		expect(result.json.status).toMatchObject({
			jobId: 'seg-job-1',
			status: 'done',
			layerPackage: {
				shotId: 'shot-1',
				layers: [
					expect.objectContaining({layerId: 'clean-plate'}),
					expect.objectContaining({layerId: 'hair'}),
				],
			},
		});
	});

	it('fails fast when the segmentation service is not configured', async () => {
		delete process.env.COMIC_SEGMENTATION_SERVICE_URL;
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const result = await post(
			requestSegmentationRoute,
			'layers/request-segmentation',
			{
				projectId: 'project-1',
				shotId: 'shot-1',
				sourceUrl: 'https://cdn.example.com/source.png',
				canvas: {width: 1080, height: 1920},
			},
		);

		expect(result.response.status).toBe(503);
		expect(result.json).toMatchObject({
			type: 'error',
			code: 'DEPENDENCY_UNAVAILABLE',
			retryable: true,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects untrusted source and layer package URLs', async () => {
		const source = await post(
			requestSegmentationRoute,
			'layers/request-segmentation',
			{
				projectId: 'project-1',
				shotId: 'shot-1',
				sourceUrl: 'https://evil.example.com/source.png',
				canvas: {width: 1080, height: 1920},
			},
		);
		expect(source.response.status).toBe(422);
		expect(source.json).toMatchObject({code: 'INVALID_REMOTE_URL'});

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				return Response.json({
					jobId: 'seg-job-1',
					status: 'done',
					layerPackage: {
						...layerPackage(),
						layers: [
							{
								...layerPackage().layers[0],
								imageUrl: 'https://evil.example.com/layer.png',
							},
						],
					},
				});
			}),
		);

		const status = await post(
			segmentationStatusRoute,
			'layers/segmentation-status',
			{jobId: 'seg-job-1'},
		);
		expect(status.response.status).toBe(422);
		expect(status.json).toMatchObject({code: 'INVALID_REMOTE_URL'});
	});
});

