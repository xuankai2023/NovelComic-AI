import {z} from 'zod';
import {deleteShot} from '../../../../../src/editor/comic/delete-shot';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const shotDeleteRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	shotId: z.string().min(1),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = shotDeleteRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return deleteShot(project, input.shotId);
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
