import {respond, withCompositorErrors} from '../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string}>};
export async function GET(_request: Request, context: Context) {
	return withCompositorErrors(async () => { const {projectId} = await context.params; return respond({snapshot: compositorStore.getSnapshot(projectId)}); });
}
