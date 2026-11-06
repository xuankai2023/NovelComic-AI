import {z} from 'zod';
import {addDialogue} from '../../../../../src/editor/comic/add-dialogue';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const dialogueAddRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	lines: z
		.array(
			z.object({
				lineId: z.string().min(1),
				shotId: z.string().min(1),
				text: z.string(),
				from: z.number().int().nonnegative(),
				durationInFrames: z.number().int().positive(),
				visible: z.boolean().optional(),
				characterId: z.string().min(1).optional(),
				voiceProfileId: z.string().min(1).optional(),
			}),
		)
		.min(1),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = dialogueAddRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return addDialogue(project, {lines: input.lines});
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
