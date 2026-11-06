import {jsonBody, requiredString, respond, withCompositorErrors} from '../../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string}>};
export async function POST(request: Request, context: Context) { return withCompositorErrors(async () => { const {projectId} = await context.params; const body = await jsonBody(request); const asset = compositorStore.completeAsset(projectId, requiredString(body.assetId, 'assetId'), {contentHash: requiredString(body.contentHash, 'contentHash'), ...(typeof body.byteSize === 'number' ? {byteSize: body.byteSize} : {}), ...(typeof body.width === 'number' ? {width: body.width} : {}), ...(typeof body.height === 'number' ? {height: body.height} : {})}); return respond({asset}); }); }
