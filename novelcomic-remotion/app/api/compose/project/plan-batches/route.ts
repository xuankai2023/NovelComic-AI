import {planOutputBatches} from '../../../../../src/editor/comic/plan-batches';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const planBatchesRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = planBatchesRequestSchema.parse(body);
		return {batches: planOutputBatches(input.project)};
	});
}
