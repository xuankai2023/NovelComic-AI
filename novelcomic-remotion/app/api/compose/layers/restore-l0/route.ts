import {z} from 'zod';
import {restoreL0} from '../../../../../src/editor/comic/import-layers';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const restoreL0RequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	shotId: z.string().min(1),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = restoreL0RequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return restoreL0(project, input.shotId);
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
