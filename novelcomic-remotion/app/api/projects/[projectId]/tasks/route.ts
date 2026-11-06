import {jsonBody, integer, requiredString, respond, withCompositorErrors} from '../../../../../src/server/compositor-http';
import {startCompositorTask} from '../../../../../src/server/compositor-tasks';
import {createDocumentCommand, type DocumentCommandType} from '../../../../../src/editor/commands/document-command-types';
import {compositorStore, type CompositorTask} from '../../../../../src/server/compositor-store';
export const runtime = 'nodejs';
type Context = {params: Promise<{projectId: string}>};
const taskTypes: CompositorTask['type'][] = ['clean-plate', 'layer-segmentation', 'tts', 'subtitle'];
export async function GET(_request: Request, context: Context) { return withCompositorErrors(async () => { const {projectId} = await context.params; return respond({tasks: compositorStore.listTasks(projectId)}); }); }
export async function POST(request: Request, context: Context) {
	return withCompositorErrors(async () => {
		const {projectId} = await context.params; const body = await jsonBody(request); const type = requiredString(body.type, 'type') as CompositorTask['type']; if (!taskTypes.includes(type)) throw new Error(`Unsupported task type: ${type}`);
		const baseRevision = integer(body.revision, 'revision'); const requestId = requiredString(body.clientRequestId, 'clientRequestId'); const task = compositorStore.createTask(projectId, {baseRevision, type, requestId});
		const rawCommands = Array.isArray(body.commands) ? body.commands : []; const commands = rawCommands.map((entry, index) => { if (!entry || typeof entry !== 'object') throw new Error(`commands[${index}] must be an object`); const source = entry as Record<string, unknown>; const commandType = requiredString(source.id ?? source.type, `commands[${index}].id`) as DocumentCommandType; const payload = source.payload && typeof source.payload === 'object' ? source.payload : Object.fromEntries(Object.entries(source).filter(([key]) => !['id', 'type', 'payload'].includes(key))); return createDocumentCommand({type: commandType as never, payload: payload as never, projectId, expectedRevision: baseRevision, id: typeof source.commandId === 'string' ? source.commandId : `${commandType}-${index}`}); });
		startCompositorTask(task, commands, body.result); return respond({task}, {status: 202});
	});
}
