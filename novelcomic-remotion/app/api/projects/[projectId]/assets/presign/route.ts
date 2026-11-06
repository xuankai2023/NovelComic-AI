import {COSConfigurationError, getCOSPresignedPutUrl, getCOSReadUrl} from '../../../../../../src/editor/utils/cos-client';
import {CompositorServiceError} from '../../../../../../src/server/compositor-errors';
import {jsonBody, requiredString, respond, withCompositorErrors} from '../../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string}>};

export async function POST(request: Request, context: Context) {
	return withCompositorErrors(async () => {
		const {projectId} = await context.params; const body = await jsonBody(request);
		const asset = compositorStore.createAssetIntent(projectId, {kind: requiredString(body.kind, 'kind') as never, originalName: requiredString(body.originalName ?? body.filename, 'originalName'), mimeType: requiredString(body.mimeType, 'mimeType'), byteSize: Number(body.byteSize), contentHash: requiredString(body.contentHash, 'contentHash'), ...(typeof body.width === 'number' ? {width: body.width} : {}), ...(typeof body.height === 'number' ? {height: body.height} : {})});
		try {
			const uploadUrl = getCOSPresignedPutUrl({key: asset.objectKey, contentType: asset.mimeType, contentLength: asset.byteSize, expiresInSeconds: 60 * 60});
			const readUrl = getCOSReadUrl(asset.objectKey);
			return respond({asset: compositorStore.setAssetUploadUrls(projectId, asset.id, {uploadUrl, readUrl})}, {status: 201});
		} catch (error) {
			if (error instanceof COSConfigurationError) throw new CompositorServiceError({code: 'STORAGE_UNAVAILABLE', message: `Object storage is not configured: ${error.missingKeys.join(', ')}`, status: 503, retryable: true});
			throw error;
		}
	});
}
