import {z} from 'zod';
import {addDialogueVoice} from '../../../../../src/editor/comic/add-dialogue-voice';
import {
	COMIC_ERROR_CODES,
	ComicEditorError,
} from '../../../../../src/editor/comic/errors';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {resolveAudioInput} from '../../../../../src/editor/compose/build-audio-item';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
	remoteUrlSchema,
} from '../../../../../src/editor/compose/schemas';
import {
	resolveAllowedHosts,
	validateRemoteUrl,
} from '../../../../../src/editor/compose/validate-remote-url';

export const runtime = 'nodejs';

const voiceSchema = z.object({
	shotId: z.string().min(1),
	lineId: z.string().min(1),
	audioUrl: remoteUrlSchema,
	from: z.number().int().nonnegative(),
	durationInFrames: z.number().int().positive(),
	sourceStartInSeconds: z.number().finite().nonnegative().optional(),
	decibelAdjustment: z.number().finite().optional(),
	characterId: z.string().min(1).optional(),
	voiceProfileId: z.string().min(1).optional(),
});

const dialogueVoiceRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	voices: z.array(voiceSchema).min(1),
});

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = dialogueVoiceRequestSchema.parse(body);
		const allowedHosts = resolveAllowedHosts();
		for (const voice of input.voices) {
			validateRemoteUrl(voice.audioUrl, {allowedHosts});
		}

		let resolved;
		try {
			resolved = await Promise.all(
				input.voices.map((voice) => {
					return resolveAudioInput({remoteUrl: voice.audioUrl});
				}),
			);
		} catch (error) {
			throw new ComicEditorError({
				code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
				message:
					error instanceof Error
						? `Could not inspect dialogue audio: ${error.message}`
						: 'Could not inspect dialogue audio',
				retryable: true,
				status: 503,
			});
		}

		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return addDialogueVoice(
					project,
					{
						voices: input.voices.map((voice, index) => {
							return {
								...voice,
								resolvedAudio: resolved[index]!,
							};
						}),
					},
					{allowedHosts},
				);
			},
		});
		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
