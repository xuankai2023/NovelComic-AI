import {createHash, randomUUID} from 'node:crypto';
import type {DocumentCommand} from '../editor/commands/document-command-types';
import {documentCommandBus} from '../editor/commands/document-command-bus';
import {hashDocument, normalizeDocument, validateDocument, type DocumentState} from '../editor/document';
import type {AssetRecord} from '../editor/document/types';
import {CompositorServiceError} from './compositor-errors';

export type CompositorProject = {
	projectId: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	currentRevision: number;
	currentSnapshotId: string;
	schemaVersion: 1;
	archived: boolean;
};

export type CompositorSnapshot = {
	snapshotId: string;
	projectId: string;
	revision: number;
	savedAt: string;
	reason: 'create' | 'command' | 'manual' | 'restore';
	contentHash: string;
	document: DocumentState;
};

export type CommandJournalEntry = {
	journalId: string;
	projectId: string;
	revision: number;
	requestId: string;
	command: DocumentCommand;
	createdAt: string;
};

export type AssetIntentStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'deleted';
export type CompositorAsset = AssetRecord & {
	projectId: string;
	status: AssetIntentStatus;
	uploadUrl?: string;
	readUrl?: string;
	thumbnailObjectKey?: string;
	proxyObjectKey?: string;
	error?: string;
	createdAt: string;
	updatedAt: string;
};

export type RenderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type CompositorRenderJob = {
	renderId: string;
	projectId: string;
	inputSnapshotId: string;
	inputRevision: number;
	inputContentHash: string;
	kind: 'preview' | 'image' | 'video';
	frame?: number;
	startFrame?: number;
	endFrame?: number;
	format: 'png' | 'jpeg' | 'mp4';
	status: RenderJobStatus;
	progress: number;
	attempt: number;
	maxAttempts: number;
	outputUrl?: string;
	outputName?: string;
	error?: {code: string; message: string; retryable: boolean};
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
};

export type CompositorTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type CompositorTask = {
	taskId: string;
	projectId: string;
	baseRevision: number;
	type: 'clean-plate' | 'layer-segmentation' | 'tts' | 'subtitle';
	status: CompositorTaskStatus;
	progress: number;
	requestId: string;
	result?: unknown;
	error?: {code: string; message: string; retryable: boolean};
	createdAt: string;
	updatedAt: string;
};

type IdempotentResult = {payloadHash: string; result: CommitResult};
export type CommitResult = {
	project: CompositorProject;
	snapshot: CompositorSnapshot;
	document: DocumentState;
	events: Array<{type: string; commandId: string}>;
};

const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const payloadHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) => item === undefined ? undefined : item)).digest('hex');
const makeId = (prefix: string) => `${prefix}_${randomUUID()}`;

/**
 * A process-local adapter keeps the server contract runnable without forcing a
 * database package into the browser project. The maps are deliberately behind
 * this service, so replacing them with PostgreSQL/Redis does not change routes.
 */
export class CompositorStore {
	private readonly projects = new Map<string, CompositorProject>();
	private readonly snapshots = new Map<string, CompositorSnapshot>();
	private readonly journals = new Map<string, CommandJournalEntry[]>();
	private readonly idempotency = new Map<string, IdempotentResult>();
	private readonly assets = new Map<string, CompositorAsset>();
	private readonly renders = new Map<string, CompositorRenderJob>();
	private readonly tasks = new Map<string, CompositorTask>();

	async createProject(document: DocumentState, projectId = document.projectId): Promise<CompositorProject> {
		const normalized = this.assertDocument(document, projectId);
		if (this.projects.has(projectId)) throw new CompositorServiceError({code: 'PROJECT_EXISTS', message: 'Project already exists', status: 409});
		const timestamp = now();
		const snapshot: CompositorSnapshot = {
			snapshotId: makeId('snapshot'), projectId, revision: 0, savedAt: timestamp,
			reason: 'create', contentHash: await hashDocument(normalized), document: clone(normalized),
		};
		const project: CompositorProject = {
			projectId, name: normalized.name, createdAt: timestamp, updatedAt: timestamp,
			currentRevision: 0, currentSnapshotId: snapshot.snapshotId, schemaVersion: 1, archived: false,
		};
		this.projects.set(projectId, project); this.snapshots.set(snapshot.snapshotId, snapshot); this.journals.set(projectId, []);
		return clone(project);
	}

	listProjects(includeArchived = false): CompositorProject[] {
		return [...this.projects.values()].filter((project) => includeArchived || !project.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(clone);
	}
	archiveProject(projectId: string, archived: boolean) {
		const project = this.projects.get(projectId);
		if (!project) throw new CompositorServiceError({code: 'PROJECT_NOT_FOUND', message: 'Project does not exist', status: 404});
		const next = {...project, archived, updatedAt: now()};
		this.projects.set(projectId, next);
		return clone(next);
	}
	getProject(projectId: string) { return clone(this.projects.get(projectId) ?? null); }
	getSnapshot(projectId: string, snapshotId?: string) {
		const project = this.requireProject(projectId);
		return clone(this.snapshots.get(snapshotId ?? project.currentSnapshotId) ?? null);
	}
	listSnapshots(projectId: string) {
		this.requireProject(projectId);
		return [...this.snapshots.values()].filter((snapshot) => snapshot.projectId === projectId).sort((a, b) => b.revision - a.revision).map(clone);
	}
	getJournal(projectId: string) { this.requireProject(projectId); return clone(this.journals.get(projectId) ?? []); }

	async commit(projectId: string, expectedRevision: number, requestId: string, commands: readonly DocumentCommand[]): Promise<CommitResult> {
		const project = this.requireProject(projectId);
		if (!requestId.trim()) throw new CompositorServiceError({code: 'INVALID_REQUEST', message: 'clientRequestId is required'});
		const requestKey = `${projectId}:${requestId}`;
		const normalizedCommands = commands.map((command) => {
			if (command.type !== 'asset.attach' && command.type !== 'mask.attach') return command;
			const asset = command.type === 'asset.attach'
				? (command as DocumentCommand<'asset.attach'>).payload.asset
				: (command as DocumentCommand<'mask.attach'>).payload.asset;
			const documentAsset: AssetRecord = {
				id: asset.id, kind: asset.kind, originalName: asset.originalName, mimeType: asset.mimeType,
				...(asset.width === undefined ? {} : {width: asset.width}), ...(asset.height === undefined ? {} : {height: asset.height}),
				byteSize: asset.byteSize, objectKey: asset.objectKey, contentHash: asset.contentHash,
				...(asset.previewObjectKey === undefined ? {} : {previewObjectKey: asset.previewObjectKey}),
			};
			return command.type === 'asset.attach'
				? {...command, payload: {asset: documentAsset}}
				: {...(command as DocumentCommand<'mask.attach'>), payload: {...(command as DocumentCommand<'mask.attach'>).payload, asset: documentAsset}};
		});
		const hash = payloadHash(normalizedCommands.map((command) => ({type: command.type, payload: command.payload})));
		const previous = this.idempotency.get(requestKey);
		if (previous) {
			if (previous.payloadHash !== hash) throw new CompositorServiceError({code: 'IDEMPOTENCY_KEY_REUSED', message: 'clientRequestId was reused with a different command batch', status: 409});
			return clone(previous.result);
		}
		if (project.currentRevision !== expectedRevision) {
			const current = this.snapshots.get(project.currentSnapshotId);
			throw new CompositorServiceError({code: 'REVISION_CONFLICT', message: `Expected revision ${expectedRevision}, current revision is ${project.currentRevision}`, status: 409, details: {expectedRevision, actualRevision: project.currentRevision, currentSnapshot: current ? clone(current) : null}});
		}
		const current = this.snapshots.get(project.currentSnapshotId);
		if (!current) throw new CompositorServiceError({code: 'SNAPSHOT_NOT_FOUND', message: 'Current snapshot is missing', status: 500});
		for (const command of normalizedCommands) {
			let assetId: string | undefined;
			if (command.type === 'asset.attach')
				assetId = (command as DocumentCommand<'asset.attach'>).payload.asset.id;
			if (command.type === 'mask.attach')
				assetId = (command as DocumentCommand<'mask.attach'>).payload.asset.id;
			if (assetId && this.assets.get(assetId)?.status !== 'ready') {
				throw new CompositorServiceError({code: 'ASSET_NOT_READY', message: `Asset ${assetId} is not ready`, status: 409});
			}
		}
		let next: DocumentState;
		try { next = documentCommandBus.executeTransaction(current.document, normalizedCommands).document; }
		catch (error) { throw new CompositorServiceError({code: 'COMMAND_INVALID', message: error instanceof Error ? error.message : 'Command batch is invalid', details: {cause: error instanceof Error && 'issues' in error ? (error as {issues?: unknown}).issues : undefined}}); }
		const timestamp = now();
		const snapshot: CompositorSnapshot = {snapshotId: makeId('snapshot'), projectId, revision: expectedRevision + 1, savedAt: timestamp, reason: 'command', contentHash: await hashDocument(next), document: clone(normalizeDocument(next))};
		const nextProject = {...project, name: next.name, currentRevision: snapshot.revision, currentSnapshotId: snapshot.snapshotId, updatedAt: timestamp};
		const journal = this.journals.get(projectId) ?? [];
		normalizedCommands.forEach((command) => journal.push({journalId: makeId('journal'), projectId, revision: snapshot.revision, requestId, command: clone(command), createdAt: timestamp}));
		this.projects.set(projectId, nextProject); this.snapshots.set(snapshot.snapshotId, snapshot); this.journals.set(projectId, journal);
		const result: CommitResult = {project: clone(nextProject), snapshot: clone(snapshot), document: clone(snapshot.document), events: normalizedCommands.map((command) => ({type: command.type, commandId: command.id}))};
		this.idempotency.set(requestKey, {payloadHash: hash, result: clone(result)});
		return result;
	}

	async restore(projectId: string, snapshotId: string, expectedRevision: number, requestId: string) {
		const snapshot = this.snapshots.get(snapshotId);
		if (!snapshot || snapshot.projectId !== projectId) throw new CompositorServiceError({code: 'SNAPSHOT_NOT_FOUND', message: 'Snapshot does not exist', status: 404});
		const command: DocumentCommand = {id: makeId('restore'), requestId, projectId, expectedRevision, type: 'project.replace', payload: {document: clone(snapshot.document)}, createdAt: now()};
		const result = await this.commit(projectId, expectedRevision, requestId, [command]);
		result.snapshot.reason = 'restore';
		return result;
	}
	async createManualSnapshot(projectId: string, expectedRevision: number) {
		const project = this.requireProject(projectId);
		if (project.currentRevision !== expectedRevision) throw new CompositorServiceError({code: 'REVISION_CONFLICT', message: `Expected revision ${expectedRevision}, current revision is ${project.currentRevision}`, status: 409, details: {expectedRevision, actualRevision: project.currentRevision}});
		const current = this.snapshots.get(project.currentSnapshotId);
		if (!current) throw new CompositorServiceError({code: 'SNAPSHOT_NOT_FOUND', message: 'Current snapshot is missing', status: 500});
		const snapshot: CompositorSnapshot = {...clone(current), snapshotId: makeId('snapshot'), savedAt: now(), reason: 'manual'};
		this.snapshots.set(snapshot.snapshotId, snapshot);
		this.projects.set(projectId, {...project, currentSnapshotId: snapshot.snapshotId, updatedAt: snapshot.savedAt});
		return clone(snapshot);
	}

	createAssetIntent(projectId: string, input: Pick<CompositorAsset, 'kind' | 'originalName' | 'mimeType' | 'byteSize' | 'contentHash'> & Partial<Pick<CompositorAsset, 'width' | 'height'>>, urls?: {uploadUrl?: string; readUrl?: string}) {
		this.requireProject(projectId);
		if (!input.originalName.trim() || input.byteSize < 0 || !Number.isFinite(input.byteSize)) throw new CompositorServiceError({code: 'INVALID_REQUEST', message: 'Asset metadata is invalid'});
		const assetId = makeId('asset'); const objectKey = `projects/${projectId}/assets/${input.contentHash}/${input.originalName.replace(/[^A-Za-z0-9._-]/g, '_')}`; const timestamp = now();
		const asset: CompositorAsset = {...input, id: assetId, objectKey, projectId, status: 'pending', ...urls, createdAt: timestamp, updatedAt: timestamp};
		this.assets.set(assetId, asset); return clone(asset);
	}
	getAsset(projectId: string, assetId: string) { const asset = this.assets.get(assetId); if (!asset || asset.projectId !== projectId) throw new CompositorServiceError({code: 'ASSET_NOT_FOUND', message: 'Asset does not exist', status: 404}); return clone(asset); }
	listAssets(projectId: string) { this.requireProject(projectId); return [...this.assets.values()].filter((asset) => asset.projectId === projectId && asset.status !== 'deleted').map(clone); }
	completeAsset(projectId: string, assetId: string, input: {contentHash: string; byteSize?: number; width?: number; height?: number}) {
		const asset = this.assets.get(assetId); if (!asset || asset.projectId !== projectId) throw new CompositorServiceError({code: 'ASSET_NOT_FOUND', message: 'Asset does not exist', status: 404});
		if (asset.contentHash !== input.contentHash || (input.byteSize !== undefined && input.byteSize !== asset.byteSize)) throw new CompositorServiceError({code: 'INVALID_REQUEST', message: 'Completed asset metadata does not match the upload intent', status: 422});
		asset.status = 'ready'; asset.updatedAt = now(); asset.width = input.width ?? asset.width; asset.height = input.height ?? asset.height; asset.thumbnailObjectKey = `${asset.objectKey}.thumb.webp`; asset.proxyObjectKey = `${asset.objectKey}.proxy.webp`; this.assets.set(assetId, asset); return clone(asset);
	}
	setAssetUploadUrls(projectId: string, assetId: string, urls: {uploadUrl: string; readUrl: string}) {
		const asset = this.assets.get(assetId);
		if (!asset || asset.projectId !== projectId) throw new CompositorServiceError({code: 'ASSET_NOT_FOUND', message: 'Asset does not exist', status: 404});
		asset.uploadUrl = urls.uploadUrl; asset.readUrl = urls.readUrl; asset.updatedAt = now(); this.assets.set(assetId, asset); return clone(asset);
	}
	deleteAsset(projectId: string, assetId: string) { const asset = this.assets.get(assetId); if (!asset || asset.projectId !== projectId) throw new CompositorServiceError({code: 'ASSET_NOT_FOUND', message: 'Asset does not exist', status: 404}); asset.status = 'deleted'; asset.updatedAt = now(); this.assets.set(assetId, asset); }
	createTask(projectId: string, input: {baseRevision: number; type: CompositorTask['type']; requestId: string}) {
		this.requireProject(projectId);
		const snapshot = [...this.snapshots.values()].find((entry) => entry.projectId === projectId && entry.revision === input.baseRevision);
		if (!snapshot) throw new CompositorServiceError({code: 'SNAPSHOT_NOT_FOUND', message: `Revision ${input.baseRevision} does not exist`, status: 404});
		const timestamp = now(); const task: CompositorTask = {taskId: makeId('task'), projectId, baseRevision: input.baseRevision, type: input.type, status: 'queued', progress: 0, requestId: input.requestId, createdAt: timestamp, updatedAt: timestamp};
		this.tasks.set(task.taskId, task); return clone(task);
	}
	getTask(projectId: string, taskId: string) { const task = this.tasks.get(taskId); if (!task || task.projectId !== projectId) throw new CompositorServiceError({code: 'RENDER_NOT_FOUND', message: 'Task does not exist', status: 404}); return clone(task); }
	listTasks(projectId: string) { this.requireProject(projectId); return [...this.tasks.values()].filter((task) => task.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone); }
	updateTask(projectId: string, taskId: string, update: Partial<CompositorTask>) { const task = this.tasks.get(taskId); if (!task || task.projectId !== projectId) throw new CompositorServiceError({code: 'RENDER_NOT_FOUND', message: 'Task does not exist', status: 404}); const next = {...task, ...update, updatedAt: now()}; this.tasks.set(taskId, next); return clone(next); }

	createRenderJob(projectId: string, input: {revision: number; kind: CompositorRenderJob['kind']; frame?: number; startFrame?: number; endFrame?: number; format: CompositorRenderJob['format']; maxAttempts?: number}) {
		const project = this.requireProject(projectId); const snapshot = [...this.snapshots.values()].find((entry) => entry.projectId === projectId && entry.revision === input.revision);
		if (!snapshot) throw new CompositorServiceError({code: 'SNAPSHOT_NOT_FOUND', message: `Revision ${input.revision} does not exist`, status: 404});
		const timestamp = now(); const job: CompositorRenderJob = {renderId: makeId('render'), projectId, inputSnapshotId: snapshot.snapshotId, inputRevision: snapshot.revision, inputContentHash: snapshot.contentHash, kind: input.kind, frame: input.frame, startFrame: input.startFrame, endFrame: input.endFrame, format: input.format, status: 'queued', progress: 0, attempt: 0, maxAttempts: input.maxAttempts ?? 3, createdAt: timestamp, updatedAt: timestamp};
		this.renders.set(job.renderId, job); void project; return clone(job);
	}
	getRenderJob(projectId: string, renderId: string) { const job = this.renders.get(renderId); if (!job || job.projectId !== projectId) throw new CompositorServiceError({code: 'RENDER_NOT_FOUND', message: 'Render job does not exist', status: 404}); return clone(job); }
	updateRenderJob(projectId: string, renderId: string, update: Partial<CompositorRenderJob>) { const job = this.renders.get(renderId); if (!job || job.projectId !== projectId) throw new CompositorServiceError({code: 'RENDER_NOT_FOUND', message: 'Render job does not exist', status: 404}); const next = {...job, ...update, updatedAt: now()}; this.renders.set(renderId, next); return clone(next); }
	cancelRender(projectId: string, renderId: string) { const job = this.getRenderJob(projectId, renderId); if (job.status === 'succeeded' || job.status === 'failed') return job; return this.updateRenderJob(projectId, renderId, {status: 'canceled', finishedAt: now(), progress: job.progress}); }

	private requireProject(projectId: string) { const project = this.projects.get(projectId); if (!project || project.archived) throw new CompositorServiceError({code: 'PROJECT_NOT_FOUND', message: 'Project does not exist', status: 404}); return project; }
	private assertDocument(document: DocumentState, projectId: string) { if (document.projectId !== projectId) throw new CompositorServiceError({code: 'INVALID_REQUEST', message: 'Document projectId does not match the project'}); const normalized = normalizeDocument(document); const issues = validateDocument(normalized); if (issues.some((issue) => issue.severity === 'error')) throw new CompositorServiceError({code: 'INVALID_REQUEST', message: 'Document validation failed', details: {issues}}); return normalized; }
}

const holder = globalThis as typeof globalThis & {__compositorStore?: CompositorStore};
export const compositorStore = holder.__compositorStore ?? (holder.__compositorStore = new CompositorStore());
