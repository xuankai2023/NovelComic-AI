import {z} from 'zod';
import {
	CLEAN_PLATE_INPAINT_MODES,
	requestCleanPlateInpaint,
} from '../../../../../src/editor/comic/clean-plate';
import {domainInvariant} from '../../../../../src/editor/comic/errors';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	remoteUrlSchema,
} from '../../../../../src/editor/compose/schemas';
import {
	resolveAllowedHosts,
	validateRemoteUrl,
} from '../../../../../src/editor/compose/validate-remote-url';

export const runtime = 'nodejs';

const inpaintRequestSchema = draftEnvelopeSchema.extend({
	projectId: z.string().min(1),
	shotId: z.string().min(1),
	sourceAssetId: z.string().min(1),
	maskAssetId: z.string().min(1),
	sourceUrl: remoteUrlSchema,
	maskUrl: remoteUrlSchema,
	canvas: z.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	}),
	mode: z.enum(CLEAN_PLATE_INPAINT_MODES),
	version: z.number().int().nonnegative(),
	fillColor: z.string().min(1).optional(),
	cloneSource: z
		.object({
			x: z.number().finite(),
			y: z.number().finite(),
		})
		.optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = inpaintRequestSchema.parse(body);
		const allowedHosts = resolveAllowedHosts();
		const sourceUrl = validateRemoteUrl(input.sourceUrl, {allowedHosts});
		const maskUrl = validateRemoteUrl(input.maskUrl, {allowedHosts});
		if (input.cloneSource) {
			if (
				input.cloneSource.x < 0 ||
				input.cloneSource.y < 0 ||
				input.cloneSource.x >= input.canvas.width ||
				input.cloneSource.y >= input.canvas.height
			) {
				throw domainInvariant('Clone source must be inside the source canvas');
			}
		}
		const result = await requestCleanPlateInpaint({
			projectId: input.projectId,
			shotId: input.shotId,
			sourceAssetId: input.sourceAssetId,
			maskAssetId: input.maskAssetId,
			sourceUrl,
			maskUrl,
			canvas: input.canvas,
			mode: input.mode,
			version: input.version,
			fillColor: input.fillColor,
			cloneSource: input.cloneSource,
			clientRequestId: input.clientRequestId,
		});
		if (!result.cleanPlateAsset.remoteUrl) {
			throw domainInvariant('Clean plate asset must include a remote URL');
		}
		const cleanPlateUrl = validateRemoteUrl(result.cleanPlateAsset.remoteUrl, {
			allowedHosts,
		});

		return {
			...result,
			cleanPlateAsset: {
				...result.cleanPlateAsset,
				remoteUrl: cleanPlateUrl,
			},
		};
	});
}
