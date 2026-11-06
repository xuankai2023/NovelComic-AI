import {z} from 'zod';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {summarizeProject} from '../../../../../src/editor/compose/project-summary';
import {projectBaseSchema} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const projectSummaryRequestSchema = z.object({
	project: projectBaseSchema,
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = projectSummaryRequestSchema.parse(body);
		return {summary: summarizeProject(input.project)};
	});
}
