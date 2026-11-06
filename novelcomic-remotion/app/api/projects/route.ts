import {createEmptyDocument} from '../../../src/editor/document';
import {CompositorServiceError} from '../../../src/server/compositor-errors';
import {integer, jsonBody, respond, withCompositorErrors} from '../../../src/server/compositor-http';
import {compositorStore} from '../../../src/server/compositor-store';

export const runtime = 'nodejs';

export async function GET(request: Request) {
	return withCompositorErrors(() => {
		const includeArchived = new URL(request.url).searchParams.get('includeArchived') === 'true';
		return respond({projects: compositorStore.listProjects(includeArchived)});
	});
}

export async function POST(request: Request) {
	return withCompositorErrors(async () => {
		const body = await jsonBody(request);
		const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId : undefined;
		const document = body.document && typeof body.document === 'object'
			? body.document as Parameters<typeof compositorStore.createProject>[0]
			: createEmptyDocument({projectId, name: typeof body.name === 'string' ? body.name : 'Untitled Document', width: body.width === undefined ? undefined : integer(body.width, 'width', 1), height: body.height === undefined ? undefined : integer(body.height, 'height', 1), resolution: body.resolution === undefined ? undefined : integer(body.resolution, 'resolution', 1)});
		if (projectId && document.projectId !== projectId) throw new CompositorServiceError({code: 'INVALID_REQUEST', message: 'document.projectId must match projectId'});
		const project = await compositorStore.createProject(document, projectId ?? document.projectId);
		const snapshot = compositorStore.getSnapshot(project.projectId);
		return respond({project, snapshot}, {status: 201});
	});
}
