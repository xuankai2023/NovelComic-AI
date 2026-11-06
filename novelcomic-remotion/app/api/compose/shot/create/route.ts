import {z} from 'zod';
import {upsertShot} from '../../../../../src/editor/comic/upsert-shot';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	cameraAnimationSchema,
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const shotTransitionSchema = z.discriminatedUnion('type', [
	z.object({type: z.literal('cut')}),
	z.object({
		type: z.literal('crossfade'),
		durationInFrames: z.number().int().positive(),
	}),
]);

const shotCreateRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	shotId: z.string().min(1),
	name: z.string().optional(),
	from: z.number().int().nonnegative().optional(),
	durationInFrames: z.number().int().positive(),
	transitionOut: shotTransitionSchema.optional(),
	cameraMotion: cameraAnimationSchema.optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = shotCreateRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return upsertShot(project, {
					shotId: input.shotId,
					name: input.name,
					from: input.from,
					durationInFrames: input.durationInFrames,
					transitionOut: input.transitionOut,
					cameraMotion: input.cameraMotion,
				});
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
