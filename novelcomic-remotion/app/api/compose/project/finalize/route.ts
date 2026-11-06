import {z} from 'zod';
import {finalizeBatchDelivery} from '../../../../../src/editor/comic/finalize-batches';
import {DELIVERY_FILE_CATEGORIES} from '../../../../../src/editor/comic/types';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

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

const deliveryFileSchema = z.object({
	path: z.string().min(1),
	category: z.enum(DELIVERY_FILE_CATEGORIES),
	order: z.number().int().nonnegative(),
	url: z.string().optional(),
	checksum: z.string().optional(),
	sizeBytes: z.number().int().nonnegative().optional(),
	missingReason: z.string().optional(),
});

const renderedBatchSchema = z.discriminatedUnion('status', [
	z.object({
		batchId: z.string().min(1),
		status: z.literal('done'),
		outputFile: z.url(),
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

const finalizeRequestSchema = draftEnvelopeSchema.extend({
	projectId: z.string().min(1),
	project: projectBaseSchema,
	batches: z.array(outputBatchSchema),
	renderedBatches: z.array(renderedBatchSchema),
	files: z.array(deliveryFileSchema).optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = finalizeRequestSchema.parse(body);
		return finalizeBatchDelivery({
			projectId: input.projectId,
			project: input.project,
			batches: input.batches,
			renderedBatches: input.renderedBatches,
			files: input.files,
			generatedAt: new Date().toISOString(),
		});
	});
}

