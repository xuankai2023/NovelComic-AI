import {jsonBody, requiredString, respond, withCompositorErrors} from '../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string}>};
export async function GET(_request: Request, context: Context) { return withCompositorErrors(async () => { const {projectId} = await context.params; return respond({assets: compositorStore.listAssets(projectId)}); }); }
export async function POST(request: Request, context: Context) {
	return withCompositorErrors(async () => { const {projectId} = await context.params; const body = await jsonBody(request); const asset = compositorStore.createAssetIntent(projectId, {kind: requiredString(body.kind, 'kind') as never, originalName: requiredString(body.originalName ?? body.filename, 'originalName'), mimeType: requiredString(body.mimeType, 'mimeType'), byteSize: Number(body.byteSize), contentHash: requiredString(body.contentHash, 'contentHash'), ...(typeof body.width === 'number' ? {width: body.width} : {}), ...(typeof body.height === 'number' ? {height: body.height} : {})}, {uploadUrl: typeof body.uploadUrl === 'string' ? body.uploadUrl : undefined, readUrl: typeof body.readUrl === 'string' ? body.readUrl : undefined}); return respond({asset}, {status: 201}); });
}
