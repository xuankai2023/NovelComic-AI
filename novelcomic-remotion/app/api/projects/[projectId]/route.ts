import {jsonBody, requiredString, respond, withCompositorErrors} from '../../../../src/server/compositor-http';
import {compositorStore} from '../../../../src/server/compositor-store';

export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string}>};

export async function GET(_request: Request, context: Context) {
	return withCompositorErrors(async () => {
		const {projectId} = await context.params; const project = compositorStore.getProject(projectId);
		if (!project) return respond({error: {code: 'PROJECT_NOT_FOUND', message: 'Project does not exist'}}, {status: 404});
		return respond({project, snapshot: compositorStore.getSnapshot(projectId)});
	});
}
export async function PATCH(request: Request, context: Context) {
	return withCompositorErrors(async () => {
		const {projectId} = await context.params; const body = await jsonBody(request); const project = compositorStore.getProject(projectId);
		if (!project) return respond({error: {code: 'PROJECT_NOT_FOUND', message: 'Project does not exist'}}, {status: 404});
		if (body.archived !== undefined) {
			if (typeof body.archived !== 'boolean') throw new Error('archived must be boolean');
			// Archive is intentionally represented as a project mutation, never a document command.
			return respond({project: compositorStore.archiveProject(projectId, body.archived)});
		}
		if (body.name !== undefined) {
			const name = requiredString(body.name, 'name');
			const current = compositorStore.getSnapshot(projectId);
			if (!current) return respond({error: {code: 'SNAPSHOT_NOT_FOUND', message: 'Current snapshot is missing'}}, {status: 500});
			const command = {id: `rename_${Date.now()}`, requestId: requiredString(body.clientRequestId, 'clientRequestId'), projectId, expectedRevision: project.currentRevision, type: 'document.rename' as const, payload: {name}, createdAt: new Date().toISOString()};
			return respond({result: await compositorStore.commit(projectId, project.currentRevision, command.requestId, [command])});
		}
		return respond({project});
	});
}
export async function DELETE(_request: Request, context: Context) {
	return withCompositorErrors(async () => { const {projectId} = await context.params; return respond({project: compositorStore.archiveProject(projectId, true)}); });
}
