import {respond, withCompositorErrors} from '../../../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
export async function GET(_request: Request, context: {params: Promise<{projectId: string; renderId: string}>}) {
	return withCompositorErrors(async () => { const {projectId, renderId} = await context.params; const render = compositorStore.getRenderJob(projectId, renderId); if (!render.outputUrl) return respond({error: {code: 'RENDER_NOT_READY', message: 'Render output is not ready'}}, {status: 409}); return respond({url: render.outputUrl, filename: render.outputName}); });
}
