import {z} from 'zod';
import {planContactSheet} from '../../../../../src/editor/comic/plan-contact-sheet';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const contactSheetRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	async: z.boolean().optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = contactSheetRequestSchema.parse(body);
		const frames = planContactSheet(input.project);
		if (!input.async) {
			return {frames};
		}

		return {
			frames,
			taskId: input.clientRequestId ?? crypto.randomUUID(),
		};
	});
}
