import {z} from 'zod';
import {editShot} from '../../../../../src/editor/comic/edit-shot';
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

const shotEditRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	shotId: z.string().min(1),
	name: z.string().optional(),
	durationInFrames: z.number().int().positive().optional(),
	cameraMotion: cameraAnimationSchema.nullable().optional(),
	transitionOut: shotTransitionSchema.nullable().optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = shotEditRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return editShot(project, {
					shotId: input.shotId,
					name: input.name,
					durationInFrames: input.durationInFrames,
					cameraMotion: input.cameraMotion,
					transitionOut: input.transitionOut,
				});
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
