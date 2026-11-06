import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createPixelLayer} from '../editor/document';
import {POST as createProject} from '../../app/api/projects/route';
import {POST as commitCommands} from '../../app/api/projects/[projectId]/commands/route';
import {GET as getSnapshot} from '../../app/api/projects/[projectId]/snapshot/route';
import {POST as createAsset} from '../../app/api/projects/[projectId]/assets/route';
import {POST as completeAsset} from '../../app/api/projects/[projectId]/assets/complete/route';
import {POST as createImageRender} from '../../app/api/projects/[projectId]/render/image/route';
import {POST as createTask} from '../../app/api/projects/[projectId]/tasks/route';
import {GET as getRender} from '../../app/api/projects/[projectId]/render/[renderId]/route';
import {DELETE as cancelRender} from '../../app/api/projects/[projectId]/render/[renderId]/route';
import {compositorStore} from './compositor-store';

const context = <T extends Record<string, string>>(params: T) => ({params: Promise.resolve(params)});
const json = async <T>(response: Response) => response.json() as Promise<T>;
const post = (url: string, body: unknown) => new Request(`https://editor.local${url}`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});

describe('Compositor stage 8 service loop', () => {
	const projectId = `stage8-${Date.now()}`;
	beforeEach(() => {
		if (compositorStore.getProject(projectId)) compositorStore.archiveProject(projectId, false);
	});
	afterEach(() => {
		const project = compositorStore.getProject(projectId);
		if (project) compositorStore.archiveProject(projectId, true);
	});

	it('creates a project, commits a document command, and preserves CAS/idempotency', async () => {
		const created = await createProject(post('/api/projects', {projectId, name: 'Stage 8', width: 64, height: 64}));
		expect(created.status).toBe(201);
		const createdBody = await json<{snapshot: {document: unknown}}>(created);
		const document = createdBody.snapshot.document;
		const asset = await createAsset(post(`/api/projects/${projectId}/assets`, {kind: 'raster', originalName: 'source.png', mimeType: 'image/png', byteSize: 12, contentHash: 'hash-source'}), context({projectId}));
		const assetBody = await json<{asset: {id: string}}>(asset);
		const ready = await completeAsset(post(`/api/projects/${projectId}/assets/complete`, {assetId: assetBody.asset.id, contentHash: 'hash-source', byteSize: 12}), context({projectId}));
		expect((await json<{asset: {status: string}}>(ready)).asset.status).toBe('ready');
		const layer = createPixelLayer(assetBody.asset.id, 'Source', 64, 64); layer.id = 'source-layer';
		const commandBody = {expectedRevision: 0, clientRequestId: 'req-layer', commands: [{id: 'asset.attach', payload: {asset: assetBody.asset}}, {id: 'layer.create', payload: {layer}}]};
		const committed = await commitCommands(post(`/api/projects/${projectId}/commands`, commandBody), context({projectId}));
		expect(committed.status).toBe(200);
		expect((await json<{revision: number}>(committed)).revision).toBe(1);
		const replay = await commitCommands(post(`/api/projects/${projectId}/commands`, commandBody), context({projectId}));
		expect((await json<{revision?: number}>(replay)).revision).toBe(1);
		const conflict = await commitCommands(post(`/api/projects/${projectId}/commands`, {...commandBody, clientRequestId: 'req-conflict'}), context({projectId}));
		expect(conflict.status).toBe(409);
		expect((await json<{error: {code: string}}>(conflict)).error.code).toBe('REVISION_CONFLICT');
		const snapshot = await getSnapshot(new Request('https://editor.local'), context({projectId}));
		expect((await json<{snapshot: {document: {layers: Record<string, unknown>}}}>(snapshot)).snapshot.document.layers['source-layer']).toBeDefined();
		void document;
	});

	it('pins render jobs to a revision and exposes terminal output', async () => {
		await createProject(post('/api/projects', {projectId, name: 'Render', width: 32, height: 32}));
		const response = await createImageRender(post(`/api/projects/${projectId}/render/image`, {revision: 0, frame: 0, format: 'png'}), context({projectId}));
		expect(response.status).toBe(202);
		const render = (await json<{render: {renderId: string; inputRevision: number}}>(response)).render;
		expect(render.inputRevision).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const status = await getRender(new Request('https://editor.local'), context({projectId, renderId: render.renderId}));
		const current = (await json<{render: {status: string; outputUrl?: string}}>(status)).render;
		expect(current.status).toBe('succeeded');
		expect(current.outputUrl).toMatch(/^data:image\/png/);
	});

	it('cancels a queued render before its worker starts', async () => {
		await createProject(post('/api/projects', {projectId, name: 'Cancel', width: 32, height: 32}));
		const response = await createImageRender(post(`/api/projects/${projectId}/render/image`, {revision: 0, frame: 0, format: 'png'}), context({projectId}));
		const render = (await json<{render: {renderId: string}}>(response)).render;
		const canceled = await cancelRender(new Request('https://editor.local'), context({projectId, renderId: render.renderId}));
		expect((await json<{render: {status: string}}>(canceled)).render.status).toBe('canceled');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(compositorStore.getRenderJob(projectId, render.renderId).status).toBe('canceled');
	});

	it('runs AI/media work as an async command write-back task', async () => {
		await createProject(post('/api/projects', {projectId, name: 'Task', width: 32, height: 32}));
		const taskResponse = await createTask(post(`/api/projects/${projectId}/tasks`, {type: 'clean-plate', revision: 0, clientRequestId: 'task-request', result: {assetId: 'clean-plate'}}), context({projectId}));
		expect(taskResponse.status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const task = compositorStore.listTasks(projectId)[0];
		expect(task.status).toBe('succeeded');
		expect(task.result).toEqual({assetId: 'clean-plate'});
	});
});
