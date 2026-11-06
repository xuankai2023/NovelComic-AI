import {GetCaptionsResponse} from '../../../src/editor/captioning/types';
import {parseCaptionProvider} from '../../../src/editor/captioning/caption-provider';
import {
	generateCaptionsFromCOS,
	parseCaptionLanguage,
} from '../../../src/editor/compose/generate-captions';
import {deleteCOSObject} from '../../../src/editor/utils/cos-client';
import {getServerEnv} from '../../../src/editor/utils/server-env';

export const runtime = 'nodejs';

export async function POST(request: Request) {
	try {
		const serverEnv = getServerEnv();
		const json = await request.json();
		const provider = parseCaptionProvider(json.provider);
		const language = parseCaptionLanguage(json.language);

		if (!json.fileKey) {
			throw new Error('fileKey is required');
		}

		const captions = await generateCaptionsFromCOS({
			fileKey: json.fileKey,
			openaiApiKey: serverEnv.OPENAI_API_KEY,
			elevenLabsApiKey: serverEnv.ELEVENLABS_API_KEY,
			provider,
			language,
		});

		const captionResponse: GetCaptionsResponse = {
			captions,
		};

		await deleteCOSObject(json.fileKey);

		return Response.json(captionResponse);
	} catch (error) {
		// eslint-disable-next-line no-console
		console.error('Captions API error:', error);
		return Response.json(
			{
				error:
					error instanceof Error
						? error.message
						: 'Caption service unavailable',
			},
			{status: 500},
		);
	}
}
