import {z} from 'zod';
import {assessImportFormat} from '../../../../../src/editor/comic/import-format-assessment';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {draftEnvelopeSchema} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const importAssessRequestSchema = draftEnvelopeSchema.extend({
	filename: z.string().min(1).optional(),
	mimeType: z.string().min(1).optional(),
	hasAlpha: z.boolean().optional(),
	sidecarFilenames: z.array(z.string().min(1)).optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = importAssessRequestSchema.parse(body);
		return {
			assessment: assessImportFormat({
				filename: input.filename,
				mimeType: input.mimeType,
				hasAlpha: input.hasAlpha,
				sidecarFilenames: input.sidecarFilenames,
			}),
		};
	});
}
