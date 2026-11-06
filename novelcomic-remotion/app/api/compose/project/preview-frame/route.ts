import {z} from 'zod';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';
import {renderPreviewFrame} from '../../../../../src/editor/rendering/render-preview-frame';

export const runtime = 'nodejs';

const previewFrameRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	frame: z.number().int().nonnegative(),
	width: z.number().int().positive().optional(),
	format: z.enum(['png', 'jpeg']).optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = previewFrameRequestSchema.parse(body);
		const preview = await renderPreviewFrame({
			project: input.project,
			frame: input.frame,
			width: input.width,
			format: input.format,
		});
		return preview;
	});
}
