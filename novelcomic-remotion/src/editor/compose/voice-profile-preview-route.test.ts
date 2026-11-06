import {afterEach, describe, expect, it, vi} from 'vitest';
import {POST as previewRoute} from '../../../app/api/compose/voice-profile/preview/route';

const originalServiceUrl = process.env.COMIC_TTS_SERVICE_URL;

const post = async (body: unknown) => {
	const response = await previewRoute(
		new Request('https://editor.local/api/compose/voice-profile/preview', {
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

const validRequest = {
	text: 'Hello from the voice preview.',
	profile: {
		id: 'voice:hero:default',
		characterId: 'hero',
		provider: 'custom',
		voiceId: 'default',
		style: 'warm',
		language: 'en-US',
	},
};

describe('voice profile preview route', () => {
	afterEach(() => {
		if (originalServiceUrl === undefined) {
			delete process.env.COMIC_TTS_SERVICE_URL;
		} else {
			process.env.COMIC_TTS_SERVICE_URL = originalServiceUrl;
		}
		vi.unstubAllGlobals();
	});

	it('returns a dependency error when the TTS service is not configured', async () => {
		delete process.env.COMIC_TTS_SERVICE_URL;

		const result = await post(validRequest);

		expect(result.response.status).toBe(503);
		expect(result.json).toMatchObject({
			type: 'error',
			code: 'DEPENDENCY_UNAVAILABLE',
			retryable: false,
		});
	});

	it('returns the audio URL from a successful TTS service response', async () => {
		process.env.COMIC_TTS_SERVICE_URL = 'https://tts.example.com/preview';
		const fetchMock = vi.fn(async () => {
			return Response.json({
				audioUrl: 'https://cdn.example.com/previews/hero.mp3',
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await post(validRequest);

		expect(result.response.status).toBe(200);
		expect(result.json).toEqual({
			type: 'success',
			audioUrl: 'https://cdn.example.com/previews/hero.mp3',
		});
		expect(fetchMock).toHaveBeenCalledWith(
			'https://tts.example.com/preview',
			expect.objectContaining({
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify(validRequest),
			}),
		);
	});

	it('returns a retryable dependency error when the TTS service fails', async () => {
		process.env.COMIC_TTS_SERVICE_URL = 'https://tts.example.com/preview';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('upstream unavailable', {status: 502})),
		);

		const result = await post(validRequest);

		expect(result.response.status).toBe(503);
		expect(result.json).toMatchObject({
			type: 'error',
			code: 'DEPENDENCY_UNAVAILABLE',
			retryable: true,
		});
	});
});
