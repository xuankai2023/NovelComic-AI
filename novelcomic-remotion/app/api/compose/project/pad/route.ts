import {z} from 'zod';
import {padProjectToMinimumDuration} from '../../../../../src/editor/comic/pad-project';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const padRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	minimumDurationInFrames: z.number().int().positive().optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = padRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return padProjectToMinimumDuration(
					project,
					input.minimumDurationInFrames,
				);
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
