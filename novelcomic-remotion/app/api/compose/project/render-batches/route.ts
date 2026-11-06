import {z} from 'zod';
import {planOutputBatches} from '../../../../../src/editor/comic/plan-batches';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {renderBatches} from '../../../../../src/editor/compose/render-batches';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';
import {submitRender} from '../../../../../src/editor/rendering/submit-render';
import {validateProject} from '../../../../../src/editor/comic/validate-project';
import {
	renderBackend,
	requireServerEnv,
} from '../../../../../src/editor/utils/server-env';

export const runtime = 'nodejs';

const renderBatchesRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	retryBatchIds: z.array(z.string().min(1)).optional(),
	inputSnapshotId: z.string().min(1).optional(),
	inputContentHash: z.string().min(1).optional(),
	preflightHash: z.string().min(1).optional(),
	warningsConfirmed: z.boolean().optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = renderBatchesRequestSchema.parse(body);
		const issues = validateProject(input.project);
		if (issues.some((issue) => issue.severity === 'error')) {
			throw new Error('Project validation errors block batch rendering.');
		}
		if (
			input.preflightHash &&
			issues.some((issue) => issue.severity === 'warning') &&
			input.warningsConfirmed !== true
		) {
			throw new Error('Project warnings require explicit confirmation.');
		}
		const batches = planOutputBatches(input.project);
		if (renderBackend() === 'lambda') {
			requireServerEnv();
		}
		const results = await renderBatches({
			project: input.project,
			batches,
			retryBatchIds: input.retryBatchIds,
			submit: submitRender,
		});
		return {
			batches,
			results: results.map((result) => {
				if (result.ok) {
					return result;
				}

				return {
					batchId: result.batchId,
					ok: false as const,
					error: {
						code: result.error.code,
						message: result.error.message,
						retryable: result.error.retryable,
					},
				};
			}),
		};
	});
}
