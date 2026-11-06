import {z} from 'zod';
import {COMIC_ERROR_CODES, ComicEditorError} from '../../../../../src/editor/comic/errors';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {VOICE_PROFILE_PROVIDERS} from '../../../../../src/editor/comic/types';

export const runtime = 'nodejs';

const requestSchema = z.object({
	text: z.string().trim().min(1).max(1000),
	profile: z.object({
		id: z.string().min(1),
		characterId: z.string().min(1),
		provider: z.enum(VOICE_PROFILE_PROVIDERS),
		voiceId: z.string().min(1),
		style: z.string().min(1).optional(),
		language: z.string().min(1).optional(),
	}),
});

const responseSchema = z.object({
	audioUrl: z.string().url(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = requestSchema.parse(body);
		const serviceUrl = process.env.COMIC_TTS_SERVICE_URL?.trim();
		if (!serviceUrl) {
			throw new ComicEditorError({
				code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
				message: 'COMIC_TTS_SERVICE_URL is not configured',
				retryable: false,
				status: 503,
			});
		}

		let response: Response;
		try {
			response = await fetch(serviceUrl, {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify(input),
			});
		} catch (error) {
			throw new ComicEditorError({
				code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
				message:
					error instanceof Error
						? `TTS preview request failed: ${error.message}`
						: 'TTS preview request failed',
				retryable: true,
				status: 503,
			});
		}

		if (!response.ok) {
			throw new ComicEditorError({
				code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
				message: `TTS preview service returned HTTP ${response.status}`,
				retryable: response.status >= 500,
				status: 503,
			});
		}

		const payload = responseSchema.safeParse(await response.json());
		if (!payload.success) {
			throw new ComicEditorError({
				code: COMIC_ERROR_CODES.INVALID_REQUEST,
				message: 'TTS preview service did not return an audioUrl',
				retryable: false,
				status: 502,
			});
		}

		return payload.data;
	});
}
