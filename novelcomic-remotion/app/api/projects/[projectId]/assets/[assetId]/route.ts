import {respond, withCompositorErrors} from '../../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string; assetId: string}>};
export async function GET(_request: Request, context: Context) { return withCompositorErrors(async () => { const {projectId, assetId} = await context.params; return respond({asset: compositorStore.getAsset(projectId, assetId)}); }); }
export async function DELETE(_request: Request, context: Context) { return withCompositorErrors(async () => { const {projectId, assetId} = await context.params; compositorStore.deleteAsset(projectId, assetId); return respond({deleted: true}); }); }
