import {z} from 'zod';
import {requestLayerSegmentation} from '../../../../../src/editor/comic/layer-segmentation';
import {
	resolveAllowedHosts,
	validateRemoteUrl,
} from '../../../../../src/editor/compose/validate-remote-url';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	remoteUrlSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const requestSegmentationSchema = draftEnvelopeSchema.extend({
	projectId: z.string().min(1),
	shotId: z.string().min(1),
	sourceUrl: remoteUrlSchema,
	canvas: z.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	}),
	semanticHints: z.array(z.string().min(1)).max(50).optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = requestSegmentationSchema.parse(body);
		const allowedHosts = resolveAllowedHosts();
		const sourceUrl = validateRemoteUrl(input.sourceUrl, {allowedHosts});
		const task = await requestLayerSegmentation({
			projectId: input.projectId,
			shotId: input.shotId,
			sourceUrl,
			canvas: input.canvas,
			semanticHints: input.semanticHints,
			clientRequestId: input.clientRequestId,
		});

		return {task};
	});
}
