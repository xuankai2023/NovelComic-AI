import {z} from 'zod';
import {getLayerSegmentationStatus} from '../../../../../src/editor/comic/layer-segmentation';
import type {LayerPackage} from '../../../../../src/editor/comic/types';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	layerPackageSchema,
} from '../../../../../src/editor/compose/schemas';
import {
	resolveAllowedHosts,
	validateRemoteUrl,
} from '../../../../../src/editor/compose/validate-remote-url';

export const runtime = 'nodejs';

const segmentationStatusSchema = draftEnvelopeSchema.extend({
	jobId: z.string().min(1),
});

const validateLayerPackageUrls = (
	layerPackage: LayerPackage,
	allowedHosts: readonly string[],
): LayerPackage => {
	validateRemoteUrl(layerPackage.sourceUrl, {allowedHosts});
	for (const layer of layerPackage.layers) {
		validateRemoteUrl(layer.imageUrl, {allowedHosts});
	}

	return layerPackage;
};

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = segmentationStatusSchema.parse(body);
		const allowedHosts = resolveAllowedHosts();
		const status = await getLayerSegmentationStatus(input.jobId, (value) => {
			return validateLayerPackageUrls(
				layerPackageSchema.parse(value),
				allowedHosts,
			);
		});

		return {status};
	});
}
