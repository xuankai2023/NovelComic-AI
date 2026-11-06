import {jsonBody, integer, requiredString, respond, withCompositorErrors} from '../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
export async function POST(request: Request, context: {params: Promise<{projectId: string}>}) {
	return withCompositorErrors(async () => { const {projectId} = await context.params; const body = await jsonBody(request); const result = await compositorStore.restore(projectId, requiredString(body.snapshotId, 'snapshotId'), integer(body.expectedRevision, 'expectedRevision'), requiredString(body.clientRequestId, 'clientRequestId')); return respond({project: result.project, snapshot: result.snapshot, document: result.document}); });
}
