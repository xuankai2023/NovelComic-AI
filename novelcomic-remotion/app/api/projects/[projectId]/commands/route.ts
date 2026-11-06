import {createDocumentCommand, type DocumentCommand, type DocumentCommandType} from '../../../../../src/editor/commands/document-command-types';
import {integer, jsonBody, requiredString, respond, withCompositorErrors} from '../../../../../src/server/compositor-http';
import {compositorStore} from '../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string}>};

const makeCommands = (projectId: string, expectedRevision: number, value: unknown): DocumentCommand[] => {
	if (!Array.isArray(value) || value.length === 0) throw new Error('commands must be a non-empty array');
	return value.map((entry, index) => {
		if (!entry || typeof entry !== 'object') throw new Error(`commands[${index}] must be an object`);
		const source = entry as Record<string, unknown>; const type = requiredString(source.id ?? source.type, `commands[${index}].id`) as DocumentCommandType;
		const payload = source.payload && typeof source.payload === 'object' ? source.payload : Object.fromEntries(Object.entries(source).filter(([key]) => !['id', 'type', 'payload', 'mergeKey'].includes(key)));
		return createDocumentCommand({type: type as never, payload: payload as never, projectId, expectedRevision, id: typeof source.commandId === 'string' ? source.commandId : `${type}-${index}`, mergeKey: typeof source.mergeKey === 'string' ? source.mergeKey : undefined});
	});
};

export async function GET(_request: Request, context: Context) {
	return withCompositorErrors(async () => { const {projectId} = await context.params; return respond({history: compositorStore.getJournal(projectId)}); });
}
export async function POST(request: Request, context: Context) {
	return withCompositorErrors(async () => {
		const {projectId} = await context.params; const body = await jsonBody(request); const expectedRevision = integer(body.expectedRevision, 'expectedRevision'); const requestId = requiredString(body.clientRequestId ?? body.requestId, 'clientRequestId');
		const commands = makeCommands(projectId, expectedRevision, body.commands ?? (body.command ? [body.command] : undefined));
		const result = await compositorStore.commit(projectId, expectedRevision, requestId, commands);
		return respond({projectId, revision: result.project.currentRevision, contentHash: result.snapshot.contentHash, state: result.document, events: result.events});
	});
}
