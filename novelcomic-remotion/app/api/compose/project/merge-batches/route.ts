import {z} from 'zod';
import {mergeBatchVideos} from '../../../../../src/editor/comic/merge-batches';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
	remoteUrlSchema,
} from '../../../../../src/editor/compose/schemas';
import {
	resolveAllowedHosts,
	validateRemoteUrl,
} from '../../../../../src/editor/compose/validate-remote-url';

export const runtime = 'nodejs';

const outputBatchSchema = z.object({
	batchId: z.string().min(1),
	batchIndex: z.number().int().nonnegative(),
	fromFrame: z.number().int().nonnegative(),
	endFrameInclusive: z.number().int().nonnegative(),
	durationInFrames: z.number().int().positive(),
	shotIds: z.array(z.string().min(1)),
	reason: z.string(),
});

const renderedBatchSchema = z.discriminatedUnion('status', [
	z.object({
		batchId: z.string().min(1),
		status: z.literal('done'),
		outputFile: remoteUrlSchema,
		outputSizeInBytes: z.number().int().nonnegative().optional(),
		checksum: z.string().min(1).optional(),
	}),
	z.object({
		batchId: z.string().min(1),
		status: z.literal('in-progress'),
	}),
	z.object({
		batchId: z.string().min(1),
		status: z.literal('error'),
		error: z.string().min(1),
	}),
]);

const mergeBatchesRequestSchema = draftEnvelopeSchema.extend({
	projectId: z.string().min(1),
	project: projectBaseSchema,
	batches: z.array(outputBatchSchema).min(1),
	renderedBatches: z.array(renderedBatchSchema),
});

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = mergeBatchesRequestSchema.parse(body);
		const allowedHosts = resolveAllowedHosts();
		const renderedBatches = input.renderedBatches.map((result) => {
			if (result.status !== 'done') {
				return result;
			}

			return {
				...result,
				outputFile: validateRemoteUrl(result.outputFile, {allowedHosts}),
			};
		});

		return mergeBatchVideos({
			projectId: input.projectId,
			project: input.project,
			batches: input.batches,
			renderedBatches,
		});
	});
}
