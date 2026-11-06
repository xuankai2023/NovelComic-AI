import {integer, jsonBody, respond, withCompositorErrors} from '../../../../../src/server/compositor-http';
import {startCompositorRender} from '../../../../../src/server/compositor-render';
import {compositorStore, type CompositorRenderJob} from '../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string}>};
const renderInput = (body: Record<string, unknown>, kind: CompositorRenderJob['kind'], format: CompositorRenderJob['format']) => ({revision: integer(body.revision, 'revision'), kind, format, ...(body.frame === undefined ? {} : {frame: integer(body.frame, 'frame')}), ...(body.startFrame === undefined ? {} : {startFrame: integer(body.startFrame, 'startFrame')}), ...(body.endFrame === undefined ? {} : {endFrame: integer(body.endFrame, 'endFrame')}), ...(body.maxAttempts === undefined ? {} : {maxAttempts: integer(body.maxAttempts, 'maxAttempts', 1)})});
export async function POST(request: Request, context: Context) {
	return withCompositorErrors(async () => { const {projectId} = await context.params; const body = await jsonBody(request); const requestedKind = body.kind === 'preview' || body.kind === 'image' || body.kind === 'video' ? body.kind : 'video'; const format = requestedKind === 'video' ? 'mp4' : body.format === 'jpeg' ? 'jpeg' : 'png'; const job = compositorStore.createRenderJob(projectId, renderInput(body, requestedKind, format)); startCompositorRender(job); return respond({render: job}, {status: 202}); });
}
