import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {POST as addDialogueRoute} from '../../../app/api/compose/dialogue/add/route';
import {POST as addImageSequenceRoute} from '../../../app/api/compose/image/sequence/route';
import {POST as createProjectRoute} from '../../../app/api/compose/project/create/route';
import {POST as summarizeProjectRoute} from '../../../app/api/compose/project/summary/route';
import {POST as validateProjectRoute} from '../../../app/api/compose/project/validate/route';
import {createComicProject} from './build-state';

const originalHosts = process.env.COMIC_ALLOWED_REMOTE_HOSTS;

const post = async (
	route: (request: Request) => Promise<Response>,
	body: unknown,
) => {
	const response = await route(
		new Request('https://editor.local/api', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}),
	);
	const json = (await response.json()) as Record<string, unknown>;
	return {response, json};
};

describe('comic compose routes', () => {
	beforeEach(() => {
		process.env.COMIC_ALLOWED_REMOTE_HOSTS = 'cdn.example.com';
	});

	afterEach(() => {
		if (originalHosts === undefined) {
			delete process.env.COMIC_ALLOWED_REMOTE_HOSTS;
		} else {
			process.env.COMIC_ALLOWED_REMOTE_HOSTS = originalHosts;
		}
	});

	it('creates a v2 comic project, adds images and dialogue, then validates', async () => {
		const created = await post(createProjectRoute, {});
		expect(created.response.status).toBe(200);
		expect(created.json.type).toBe('success');
		const project = created.json.project as {
			schemaVersion: number;
			compositionWidth: number;
			compositionHeight: number;
			fps: number;
			shots: unknown[];
		};
		expect(project).toMatchObject({
			schemaVersion: 3,
			compositionWidth: 1080,
			compositionHeight: 1920,
			fps: 30,
			shots: [],
		});

		const custom = await post(createProjectRoute, {
			compositionWidth: 720,
			compositionHeight: 1280,
			fps: 24,
		});
		expect(custom.json.project).toMatchObject({
			compositionWidth: 720,
			compositionHeight: 1280,
			fps: 24,
		});

		const sequenced = await post(addImageSequenceRoute, {
			project,
			images: [
				{
					shotId: 'shot-1',
					url: 'https://cdn.example.com/one.png',
					width: 1080,
					height: 1920,
					durationInFrames: 30,
					cameraPresetId: 'camera-push',
				},
				{
					shotId: 'shot-2',
					url: 'https://cdn.example.com/two.png',
					width: 800,
					height: 1600,
					durationInFrames: 45,
				},
				{
					shotId: 'shot-3',
					url: 'https://cdn.example.com/three.png',
					width: 1920,
					height: 1080,
					durationInFrames: 60,
				},
			],
		});
		expect(sequenced.response.status).toBe(200);
		const sequencedProject = sequenced.json.project as {
			tracks: unknown[];
			shots: {
				id: string;
				from: number;
				cameraMotion?: {keyframes: unknown[]};
			}[];
			items: Record<string, {width: number}>;
		};
		expect(sequencedProject.tracks).toHaveLength(3);
		expect(sequencedProject.shots.map((shot) => shot.from)).toEqual([
			0, 30, 75,
		]);
		expect(sequencedProject.shots[0]?.cameraMotion?.keyframes).toHaveLength(2);

		const replay = await post(addImageSequenceRoute, {
			project: sequencedProject,
			images: [
				{
					shotId: 'shot-1',
					url: 'https://cdn.example.com/one.png',
					width: 1080,
					height: 1920,
					durationInFrames: 30,
					cameraPresetId: 'camera-push',
				},
				{
					shotId: 'shot-2',
					url: 'https://cdn.example.com/two.png',
					width: 800,
					height: 1600,
					durationInFrames: 45,
				},
				{
					shotId: 'shot-3',
					url: 'https://cdn.example.com/three.png',
					width: 1920,
					height: 1080,
					durationInFrames: 60,
				},
			],
		});
		const replayProject = replay.json.project as {tracks: unknown[]};
		expect(replayProject.tracks).toHaveLength(3);

		const withDialogue = await post(addDialogueRoute, {
			project: sequencedProject,
			lines: [
				{
					lineId: 'line-1',
					shotId: 'shot-1',
					text: '第一句',
					from: 0,
					durationInFrames: 15,
				},
			],
		});
		expect(withDialogue.response.status).toBe(200);
		const dialogueProject = withDialogue.json.project as {
			tracks: {semantic?: string}[];
			items: Record<string, {width?: number; type: string}>;
		};
		expect(dialogueProject.tracks[0]?.semantic).toBe('dialogue');
		expect(
			Object.values(dialogueProject.items).some((item) => item.width === 1080),
		).toBe(true);

		const validated = await post(validateProjectRoute, {
			project: dialogueProject,
		});
		expect(validated.response.status).toBe(200);
		expect(validated.json).toMatchObject({type: 'success', valid: true});

		const summary = await post(summarizeProjectRoute, {
			project: dialogueProject,
		});
		expect(summary.response.status).toBe(200);
		expect(summary.json.summary).toMatchObject({
			schemaVersion: 3,
			compositionWidth: 1080,
			compositionHeight: 1920,
		});
		expect(summary.json.summary).toEqual(
			expect.objectContaining({
				shots: expect.any(Array),
				errors: [],
			}),
		);
	});

	it('returns stable errors for bad JSON, private URLs, and invalid projects', async () => {
		const invalidJson = await createProjectRoute(
			new Request('https://editor.local/api', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: '{',
			}),
		);
		const invalidBody = (await invalidJson.json()) as Record<string, unknown>;
		expect(invalidJson.status).toBe(400);
		expect(invalidBody).toMatchObject({
			type: 'error',
			code: 'INVALID_REQUEST',
			retryable: false,
		});
		expect(invalidBody).not.toHaveProperty('stack');

		const created = await post(createProjectRoute, {});
		const blocked = await post(addImageSequenceRoute, {
			project: created.json.project,
			images: [
				{
					shotId: 'shot-1',
					url: 'https://127.0.0.1/secret.png',
					width: 100,
					height: 100,
					durationInFrames: 10,
				},
			],
		});
		expect(blocked.response.status).toBe(422);
		expect(blocked.json).toMatchObject({
			type: 'error',
			code: 'INVALID_REMOTE_URL',
		});
		expect(blocked.json).not.toHaveProperty('stack');

		const outside = await post(addDialogueRoute, {
			project: createComicProject(),
			lines: [
				{
					lineId: 'line-1',
					shotId: 'missing',
					text: '没有镜头',
					from: 0,
					durationInFrames: 10,
				},
			],
		});
		expect(outside.response.status).toBe(422);
		expect(outside.json).toMatchObject({
			type: 'error',
			code: 'DOMAIN_INVARIANT',
		});

		const broken = await post(validateProjectRoute, {
			project: {
				...createComicProject(),
				tracks: [
					{
						id: 'track-missing',
						items: ['missing-item'],
						hidden: false,
						muted: false,
					},
				],
			},
		});
		expect(broken.response.status).toBe(200);
		expect(broken.json).toMatchObject({type: 'success', valid: false});
	});
});
