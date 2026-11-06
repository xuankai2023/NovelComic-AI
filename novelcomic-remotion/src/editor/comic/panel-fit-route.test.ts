import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {POST as addImageSequenceRoute} from '../../../app/api/compose/image/sequence/route';
import {createComicProject} from '../compose/build-state';
import {panelFitIds} from './panel-fit';

const originalHosts = process.env.COMIC_ALLOWED_REMOTE_HOSTS;

const post = async (body: unknown) => {
	const response = await addImageSequenceRoute(
		new Request('https://editor.local/api/compose/image/sequence', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}),
	);
	const json = (await response.json()) as {
		project?: {tracks: Array<{id: string}>};
		code?: string;
	};
	return {response, json};
};

const image = {
	shotId: 'wide',
	url: 'https://cdn.example.com/wide.png',
	width: 1920,
	height: 1080,
	durationInFrames: 30,
};

describe('image/sequence panel fit policy', () => {
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

	it('accepts blurred-background-contain and rejects any other policy', async () => {
		const accepted = await post({
			project: createComicProject(),
			images: [image],
			panelFitPolicy: 'blurred-background-contain',
			fitAlgorithmVersion: 'contain-blur-v1',
			blurRadiusPx: 28,
			dimOpacity: 0.45,
		});
		expect(accepted.response.status).toBe(200);
		const ids = panelFitIds('wide');
		expect(accepted.json.project?.tracks.map((track) => track.id)).toEqual([
			ids.foregroundTrackId,
			ids.backgroundTrackId,
		]);

		const rejected = await post({
			project: createComicProject(),
			images: [image],
			panelFitPolicy: 'contain',
		});
		expect(rejected.response.status).toBe(400);
		expect(rejected.json.code).toBe('INVALID_REQUEST');
	});
});
