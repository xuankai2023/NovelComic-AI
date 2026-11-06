import {afterEach, describe, expect, it, vi} from 'vitest';

const cosMocks = vi.hoisted(() => {
	return {
		getCOSReadUrl: vi.fn((key: string) => `https://cdn.example.com/${key}`),
		putCOSObject: vi.fn(async () => undefined),
	};
});

vi.mock('../utils/cos-client', () => {
	return cosMocks;
});

import {POST as dialogueRoute} from '../../../app/api/compose/dialogue/add/route';
import {POST as dialogueVoiceRoute} from '../../../app/api/compose/dialogue/voice/route';
import {POST as imageSequenceRoute} from '../../../app/api/compose/image/sequence/route';
import {POST as editItemRoute} from '../../../app/api/compose/item/edit/route';
import {POST as motionRoute} from '../../../app/api/compose/item/motion/route';
import {POST as importManualLayersRoute} from '../../../app/api/compose/layers/import-manual/route';
import {POST as importLayersRoute} from '../../../app/api/compose/layers/import/route';
import {POST as requestSegmentationRoute} from '../../../app/api/compose/layers/request-segmentation/route';
import {POST as restoreL0Route} from '../../../app/api/compose/layers/restore-l0/route';
import {POST as segmentationStatusRoute} from '../../../app/api/compose/layers/segmentation-status/route';
import {POST as contactSheetRoute} from '../../../app/api/compose/project/contact-sheet/route';
import {POST as createProjectRoute} from '../../../app/api/compose/project/create/route';
import {POST as exportPackageRoute} from '../../../app/api/compose/project/export-package/route';
import {POST as finalizeRoute} from '../../../app/api/compose/project/finalize/route';
import {POST as planBatchesRoute} from '../../../app/api/compose/project/plan-batches/route';
import {POST as previewFrameRoute} from '../../../app/api/compose/project/preview-frame/route';
import {POST as renderBatchesRoute} from '../../../app/api/compose/project/render-batches/route';
import {POST as summaryRoute} from '../../../app/api/compose/project/summary/route';
import {POST as validateRoute} from '../../../app/api/compose/project/validate/route';
import {POST as createShotRoute} from '../../../app/api/compose/shot/create/route';
import {POST as deleteShotRoute} from '../../../app/api/compose/shot/delete/route';
import {POST as editShotRoute} from '../../../app/api/compose/shot/edit/route';
import {projectContentHash} from '../comic/content-hash';
import {createComicProject} from './build-state';

const routes: Array<[string, (request: Request) => Promise<Response>]> = [
	['project/create', createProjectRoute],
	['image/sequence', imageSequenceRoute],
	['dialogue/add', dialogueRoute],
	['dialogue/voice', dialogueVoiceRoute],
	['project/summary', summaryRoute],
	['project/validate', validateRoute],
	['shot/create', createShotRoute],
	['shot/edit', editShotRoute],
	['shot/delete', deleteShotRoute],
	['layers/import', importLayersRoute],
	['layers/import-manual', importManualLayersRoute],
	['layers/restore-l0', restoreL0Route],
	['layers/request-segmentation', requestSegmentationRoute],
	['layers/segmentation-status', segmentationStatusRoute],
	['item/motion', motionRoute],
	['item/edit', editItemRoute],
	['project/plan-batches', planBatchesRoute],
	['project/render-batches', renderBatchesRoute],
	['project/finalize', finalizeRoute],
	['project/preview-frame', previewFrameRoute],
	['project/contact-sheet', contactSheetRoute],
	['project/export-package', exportPackageRoute],
];

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

const comicProject = () => {
	return {
		...createComicProject(),
		shots: [
			{
				id: 'a',
				name: 'a',
				from: 0,
				durationInFrames: 120,
				layerTrackIds: [],
				dialogueItemIds: [],
				transitionOut: {type: 'crossfade', durationInFrames: 15},
			},
			{
				id: 'b',
				name: 'b',
				from: 105,
				durationInFrames: 120,
				layerTrackIds: [],
				dialogueItemIds: [],
			},
		],
	};
};

describe('stage 5 compose routes', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('returns contact-sheet frames and an optional task id', async () => {
		const project = comicProject();
		const sync = await post(contactSheetRoute, 'project/contact-sheet', {
			project,
		});
		expect(sync.response.status).toBe(200);
		expect(sync.json.frames).toEqual([
			{shotId: 'a', frame: 52},
			{shotId: 'b', frame: 172},
		]);
		expect(sync.json).not.toHaveProperty('taskId');

		const deferred = await post(contactSheetRoute, 'project/contact-sheet', {
			project,
			async: true,
			clientRequestId: 'sheet-task-1',
		});
		expect(deferred.json.frames).toEqual(sync.json.frames);
		expect(deferred.json.taskId).toBe('sheet-task-1');
	});

	it('builds and uploads a delivery package with playback order, checksums, and content hash', async () => {
		const project = createComicProject();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				return new Response(Buffer.from('video'), {status: 200});
			}),
		);
		const exported = await post(exportPackageRoute, 'project/export-package', {
			projectId: 'project-1',
			project,
			batches: [
				{
					batchId: 'batch-a',
					batchIndex: 1,
					fromFrame: 0,
					endFrameInclusive: 149,
					durationInFrames: 150,
					shotIds: ['shot-1'],
					reason: 'target-range',
				},
			],
			files: [
				{
					path: 'videos/a.mp4',
					category: 'final-video',
					order: 1,
					url: 'https://cdn.example.com/a.mp4',
					checksum: 'abc',
				},
			],
		});
		const manifest = exported.json.manifest as {
			projectContentHash: string;
			playOrder: string[];
			files: Array<{
				category: string;
				missingReason?: string;
				checksum?: string;
			}>;
		};

		expect(exported.response.status).toBe(200);
		expect(exported.json.packageUrl).toMatch(
			/^https:\/\/cdn\.example\.com\/deliveries\/project-1\/.+\.zip$/,
		);
		expect(exported.json.packageSizeBytes).toEqual(expect.any(Number));
		expect(exported.json.missingFiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({path: 'missing/audio'}),
			]),
		);
		expect(cosMocks.putCOSObject).toHaveBeenCalledWith(
			expect.objectContaining({
				key: expect.stringMatching(/^deliveries\/project-1\/.+\.zip$/),
				contentType: 'application/zip',
				body: expect.any(Buffer),
			}),
		);
		expect(manifest.playOrder).toEqual(['videos/a.mp4']);
		expect(manifest.projectContentHash).toBe(projectContentHash(project));
		expect(manifest.files).toContainEqual({
			path: 'missing/audio',
			category: 'audio',
			order: 0,
			missingReason: 'Missing audio',
		});
		expect(
			manifest.files.find((file) => file.checksum === 'abc'),
		).toMatchObject({path: 'videos/a.mp4'});
	});

	it('finalizes batch render outputs into a playback manifest', async () => {
		const project = createComicProject();
		const finalized = await post(finalizeRoute, 'project/finalize', {
			projectId: 'project-1',
			project,
			batches: [
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
			],
			renderedBatches: [
				{
					batchId: 'batch-a',
					status: 'done',
					outputFile: 'https://cdn.example.com/renders/a.mp4',
					outputSizeInBytes: 100,
					checksum: 'sum-a',
				},
				{
					batchId: 'batch-b',
					status: 'in-progress',
				},
			],
		});

		expect(finalized.response.status).toBe(200);
		expect(finalized.json.finalVideoFiles).toEqual([
			{
				path: 'final-video/batch-a.mp4',
				category: 'final-video',
				order: 1,
				url: 'https://cdn.example.com/renders/a.mp4',
				sizeBytes: 100,
				checksum: 'sum-a',
			},
		]);
		expect(finalized.json.playOrder).toEqual([
			'final-video/batch-a.mp4',
			'final-video/batch-b.mp4',
		]);
		expect(finalized.json.incompleteBatches).toEqual([
			{
				batchId: 'batch-b',
				batchIndex: 2,
				status: 'in-progress',
				retryable: false,
				message: 'Batch batch-b is still rendering',
			},
		]);
		expect(
			(
				finalized.json.manifest as {
					files: Array<{path: string; missingReason?: string}>;
				}
			).files,
		).toContainEqual({
			path: 'final-video/batch-b.mp4',
			category: 'final-video',
			order: 2,
			missingReason: 'Missing final video for batch batch-b',
		});
	});

	it('rejects an out-of-range preview frame before calling Lambda', async () => {
		const preview = await post(previewFrameRoute, 'project/preview-frame', {
			project: createComicProject(),
			frame: 0,
		});

		expect(preview.response.status).toBe(422);
		expect(preview.json).toMatchObject({
			type: 'error',
			code: 'DOMAIN_INVARIANT',
		});
	});

	it('logs every comic compose route without the signed query or project json', async () => {
		const lines: string[] = [];
		vi.spyOn(console, 'info').mockImplementation((message) => {
			lines.push(String(message));
		});
		const signed = 'https://cdn.example.com/a.png?X-Amz-Signature=secret-token';

		for (const [operation, route] of routes) {
			const response = await route(
				new Request(`https://editor.local/api/compose/${operation}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-request-id': `req-${operation}`,
					},
					body: '{',
				}),
			);
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.headers.get('x-request-id')).toBe(`req-${operation}`);
			const logged = JSON.parse(
				lines.find((line) => line.includes(`"requestId":"req-${operation}"`)) ??
					'{}',
			) as Record<string, unknown>;
			expect(logged).toMatchObject({
				requestId: `req-${operation}`,
				operation,
				itemCount: 0,
				shotCount: 0,
				assetCount: 0,
				code: 'INVALID_REQUEST',
			});
			expect(logged.durationMs).toEqual(expect.any(Number));
			expect(JSON.stringify(logged)).not.toContain('stack');
		}

		const counted = await post(summaryRoute, 'project/summary', {
			project: {
				...createComicProject(),
				assets: {
					secret: {
						id: 'secret',
						type: 'image',
						remoteUrl: signed,
						filename: 'full-project-marker',
					},
				},
			},
		});
		expect(counted.response.ok).toBe(true);
		const joined = lines.join('\n');
		expect(joined).not.toContain('secret-token');
		expect(joined).not.toContain('full-project-marker');
		expect(joined).not.toContain('X-Amz-Signature');
	});
});
