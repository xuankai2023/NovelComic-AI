import {jsonBody, integer, respond, withCompositorErrors} from '../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string}>};
export async function GET(_request: Request, context: Context) {
	return withCompositorErrors(async () => { const {projectId} = await context.params; return respond({snapshots: compositorStore.listSnapshots(projectId)}); });
}
export async function POST(request: Request, context: Context) {
	return withCompositorErrors(async () => {
		const {projectId} = await context.params; const body = await jsonBody(request); const snapshot = await compositorStore.createManualSnapshot(projectId, integer(body.expectedRevision, 'expectedRevision'));
		return respond({snapshot}, {status: 201});
	});
}
