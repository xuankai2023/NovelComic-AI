import {z} from 'zod';
import {buildDeliveryPackage} from '../../../../../src/editor/comic/export-package';
import {DELIVERY_FILE_CATEGORIES} from '../../../../../src/editor/comic/types';
import {validateProject} from '../../../../../src/editor/comic/validate-project';
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

const exportPackageRequestSchema = draftEnvelopeSchema.extend({
	projectId: z.string().min(1),
	project: projectBaseSchema,
	batches: z.array(outputBatchSchema),
	files: z.array(
		z.object({
			path: z.string().min(1),
			category: z.enum(DELIVERY_FILE_CATEGORIES),
			order: z.number().int().nonnegative(),
			url: z.string().optional(),
			checksum: z.string().optional(),
			sizeBytes: z.number().int().nonnegative().optional(),
			missingReason: z.string().optional(),
		}),
	),
	inputSnapshotId: z.string().min(1).optional(),
	inputRevision: z.number().int().nonnegative().optional(),
	inputContentHash: z.string().min(1).optional(),
	preflightHash: z.string().min(1).optional(),
	warningsConfirmed: z.boolean().optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = exportPackageRequestSchema.parse(body);
		const issues = validateProject(input.project);
		if (issues.some((issue) => issue.severity === 'error')) {
			throw new Error('Project validation errors block delivery export.');
		}
		if (
			input.preflightHash &&
			issues.some((issue) => issue.severity === 'warning') &&
			input.warningsConfirmed !== true
		) {
			throw new Error('Project warnings require explicit confirmation.');
		}
		if (input.inputContentHash && !input.preflightHash) {
			throw new Error('A preflight hash is required for traced delivery export.');
		}
		const deliveryPackage = await buildDeliveryPackage({
			projectId: input.projectId,
			project: input.project,
			batches: input.batches,
			files: input.files,
			generatedAt: new Date().toISOString(),
			inputSnapshotId: input.inputSnapshotId,
			inputRevision: input.inputRevision,
			inputContentHash: input.inputContentHash,
			preflightHash: input.preflightHash,
		});
		return deliveryPackage;
	});
}
