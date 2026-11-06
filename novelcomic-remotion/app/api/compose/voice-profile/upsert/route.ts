import {z} from 'zod';
import {VOICE_PROFILE_PROVIDERS} from '../../../../../src/editor/comic/types';
import {upsertVoiceProfile} from '../../../../../src/editor/comic/voice-profiles';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const voiceProfileSchema = z.object({
	id: z.string().min(1),
	characterId: z.string().min(1),
	displayName: z.string().min(1).optional(),
	provider: z.enum(VOICE_PROFILE_PROVIDERS),
	voiceId: z.string().min(1),
	style: z.string().min(1).optional(),
	language: z.string().min(1).optional(),
	defaultForCharacter: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

const voiceProfileUpsertRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	profile: voiceProfileSchema,
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = voiceProfileUpsertRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return upsertVoiceProfile(project, input.profile);
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
