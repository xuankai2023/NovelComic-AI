import {respond, withCompositorErrors} from '../../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
export async function GET(_request: Request, context: {params: Promise<{projectId: string; taskId: string}>}) { return withCompositorErrors(async () => { const {projectId, taskId} = await context.params; return respond({task: compositorStore.getTask(projectId, taskId)}); }); }
export async function DELETE(_request: Request, context: {params: Promise<{projectId: string; taskId: string}>}) { return withCompositorErrors(async () => { const {projectId, taskId} = await context.params; return respond({task: compositorStore.updateTask(projectId, taskId, {status: 'canceled'})}); }); }
