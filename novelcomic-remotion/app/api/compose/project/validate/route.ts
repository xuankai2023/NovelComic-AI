import {z} from 'zod';
import {validateProject} from '../../../../../src/editor/comic/validate-project';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {projectBaseSchema} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const projectValidateRequestSchema = z.object({
	project: projectBaseSchema,
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = projectValidateRequestSchema.parse(body);
		const issues = validateProject(input.project);
		return {
			valid: !issues.some((issue) => issue.severity === 'error'),
			issues,
		};
	});
}
