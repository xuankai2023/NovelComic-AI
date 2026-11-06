import type {RenderJob} from '../rendering/render-job-types';
import {getInitialState} from '../state/initial-state';
import {normalizeUndoableState} from '../state/normalize-undoable-state';
import type {UndoableState} from '../state/types';
import {browserProjectHash as projectContentHash} from './browser-project-hash';
import {
	PROJECT_SCHEMA_VERSION,
	type CreateProjectInput,
	type DraftRecord,
	type LegacyMigrationResult,
	type ListProjectsOptions,
	type ProjectRecord,
	type ProjectSnapshot,
	type SnapshotInput,
	type SnapshotReason,
} from './types';

export const PROJECT_DB_NAME = 'novelcomic-remotion-mvp';
export const PROJECT_DB_VERSION = 1;
export const PROJECT_STORE_PROJECTS = 'projects';
export const PROJECT_STORE_SNAPSHOTS = 'snapshots';
export const PROJECT_STORE_DRAFTS = 'drafts';
export const PROJECT_STORE_RENDER_JOBS = 'renderJobs';
export const LEGACY_STATE_STORAGE_KEY = 'remotion-editor-starter-state-v3';
export const LEGACY_MIGRATION_PROJECT_KEY =
	'novelcomic-remotion-mvp-legacy-project-id';
export const AUTOMATIC_SNAPSHOT_LIMIT = 50;

export type ProjectStorageErrorCode =
	| 'unavailable'
	| 'quota-exceeded'
	| 'transaction-failed'
	| 'not-found'
	| 'invalid';

export class ProjectStorageError extends Error {
	readonly code: ProjectStorageErrorCode;
	readonly cause?: unknown;

	constructor(code: ProjectStorageErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = 'ProjectStorageError';
		this.code = code;
		this.cause = cause;
	}
}

let databasePromise: Promise<IDBDatabase> | null = null;

const makeId = (prefix: string) => {
	const cryptoObject = globalThis.crypto;
	if (cryptoObject?.randomUUID) {
		return cryptoObject.randomUUID();
	}
	const randomHex = (length: number) =>
		Array.from({length}, () =>
			Math.floor(Math.random() * 16).toString(16),
		).join('');
	const uuid = `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-${(
		8 + Math.floor(Math.random() * 4)
	).toString(16)}${randomHex(3)}-${randomHex(12)}`;
	return prefix === 'project' ? uuid : `${prefix}-${uuid}`;
};

const nowIso = () => new Date().toISOString();

const isQuotaError = (error: unknown) => {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	const candidate = error as {name?: string; code?: number};
	return candidate.name === 'QuotaExceededError' || candidate.code === 22;
};

const toStorageError = (
	error: unknown,
	defaultCode: ProjectStorageErrorCode,
	defaultMessage: string,
) => {
	if (error instanceof ProjectStorageError) {
		return error;
	}
	if (isQuotaError(error)) {
		return new ProjectStorageError(
			'quota-exceeded',
			'Project storage is full. Export a backup or remove old snapshots before saving again.',
			error,
		);
	}
	const detail = error instanceof Error ? `: ${error.message}` : '';
	return new ProjectStorageError(
		defaultCode,
		`${defaultMessage}${detail}`,
		error,
	);
};

const assertStorageAvailable = () => {
	if (typeof indexedDB === 'undefined') {
		throw new ProjectStorageError(
			'unavailable',
			'Project storage requires a browser with IndexedDB enabled.',
		);
	}
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
	new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error('IndexedDB request failed'));
	});

const transactionComplete = (transaction: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(transaction.error ?? new Error('IndexedDB transaction failed'));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
	});

const openDatabase = (): Promise<IDBDatabase> => {
	assertStorageAvailable();
	if (databasePromise) {
		return databasePromise;
	}

	databasePromise = new Promise((resolve, reject) => {
		let request: IDBOpenDBRequest;
		try {
			request = indexedDB.open(PROJECT_DB_NAME, PROJECT_DB_VERSION);
		} catch (error) {
			reject(
				toStorageError(error, 'unavailable', 'Unable to open project storage'),
			);
			return;
		}

		request.onupgradeneeded = () => {
			try {
				const database = request.result;
				const projects = database.objectStoreNames.contains(
					PROJECT_STORE_PROJECTS,
				)
					? request.transaction!.objectStore(PROJECT_STORE_PROJECTS)
					: database.createObjectStore(PROJECT_STORE_PROJECTS, {
							keyPath: 'projectId',
						});
				const snapshots = database.objectStoreNames.contains(
					PROJECT_STORE_SNAPSHOTS,
				)
					? request.transaction!.objectStore(PROJECT_STORE_SNAPSHOTS)
					: database.createObjectStore(PROJECT_STORE_SNAPSHOTS, {
							keyPath: 'snapshotId',
						});
				if (!snapshots.indexNames.contains('projectIdRevision')) {
					snapshots.createIndex('projectIdRevision', ['projectId', 'revision']);
				}
				if (!snapshots.indexNames.contains('projectId')) {
					snapshots.createIndex('projectId', 'projectId');
				}
				if (!database.objectStoreNames.contains(PROJECT_STORE_DRAFTS)) {
					database.createObjectStore(PROJECT_STORE_DRAFTS, {
						keyPath: 'projectId',
					});
				}
				if (!database.objectStoreNames.contains(PROJECT_STORE_RENDER_JOBS)) {
					const renderJobs = database.createObjectStore(
						PROJECT_STORE_RENDER_JOBS,
						{
							keyPath: 'jobId',
						},
					);
					renderJobs.createIndex('projectId', 'projectId');
					renderJobs.createIndex('projectIdStatusCreatedAt', [
						'projectId',
						'status',
						'createdAt',
					]);
				} else {
					const renderJobs = request.transaction!.objectStore(
						PROJECT_STORE_RENDER_JOBS,
					);
					if (!renderJobs.indexNames.contains('projectId')) {
						renderJobs.createIndex('projectId', 'projectId');
					}
					if (!renderJobs.indexNames.contains('projectIdStatusCreatedAt')) {
						renderJobs.createIndex('projectIdStatusCreatedAt', [
							'projectId',
							'status',
							'createdAt',
						]);
					}
				}
				void projects;
			} catch (error) {
				request.transaction?.abort();
				reject(
					toStorageError(
						error,
						'transaction-failed',
						'Unable to initialize project storage',
					),
				);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(
				toStorageError(
					request.error,
					'unavailable',
					'Unable to open project storage',
				),
			);
		request.onblocked = () =>
			reject(
				new ProjectStorageError(
					'unavailable',
					'Project storage is blocked by another browser tab. Close the other tab and retry.',
				),
			);
	});

	databasePromise = databasePromise.catch((error) => {
		databasePromise = null;
		throw error;
	});
	return databasePromise;
};

const runTransaction = async <T>(
	storeNames: string[],
	mode: IDBTransactionMode,
	operation: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> => {
	const database = await openDatabase();
	let transaction: IDBTransaction;
	try {
		transaction = database.transaction(storeNames, mode);
	} catch (error) {
		throw toStorageError(
			error,
			'transaction-failed',
			'Unable to start project transaction',
		);
	}

	const completion = transactionComplete(transaction);
	try {
		const result = await operation(transaction);
		await completion;
		return result;
	} catch (error) {
		try {
			transaction.abort();
		} catch {
			// The transaction may already have completed or aborted.
		}
		try {
			await completion;
		} catch {
			// Preserve the original request error below.
		}
		throw toStorageError(
			error,
			'transaction-failed',
			'Project transaction failed',
		);
	}
};

const clone = <T>(value: T): T => {
	if (typeof structuredClone === 'function') {
		return structuredClone(value);
	}
	return JSON.parse(JSON.stringify(value)) as T;
};

const validateName = (name: string) => {
	if (!name.trim()) {
		throw new ProjectStorageError('invalid', 'Project name cannot be empty.');
	}
};

const automaticReason = (reason: SnapshotReason) =>
	reason === 'command' || reason === 'autosave';

const isCompleteSnapshot = (
	snapshot: ProjectSnapshot | SnapshotInput,
): snapshot is ProjectSnapshot =>
	snapshot.snapshotId !== undefined &&
	snapshot.revision !== undefined &&
	snapshot.savedAt !== undefined &&
	snapshot.contentHash !== undefined;

const allSnapshots = async (
	store: IDBObjectStore,
	projectId?: string,
): Promise<ProjectSnapshot[]> => {
	const snapshots = (await requestResult(store.getAll())) as ProjectSnapshot[];
	return snapshots
		.filter((snapshot) => !projectId || snapshot.projectId === projectId)
		.sort((a, b) => a.revision - b.revision);
};

const purgeAutomaticSnapshots = async (
	snapshotStore: IDBObjectStore,
	projectId: string,
) => {
	const snapshots = await allSnapshots(snapshotStore, projectId);
	const automatic = snapshots.filter((snapshot) =>
		automaticReason(snapshot.reason),
	);
	if (automatic.length <= AUTOMATIC_SNAPSHOT_LIMIT) {
		return;
	}
	const toDelete = automatic.slice(
		0,
		automatic.length - AUTOMATIC_SNAPSHOT_LIMIT,
	);
	for (const snapshot of toDelete) {
		await requestResult(snapshotStore.delete(snapshot.snapshotId));
	}
};

export class ProjectStore {
	async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
		assertStorageAvailable();
		validateName(input.name);
		const projectId = input.projectId ?? makeId('project');
		const createdAt = input.createdAt ?? nowIso();
		const state = normalizeUndoableState(
			clone(input.state ?? getInitialState().undoableState),
		);
		const snapshot: ProjectSnapshot = {
			snapshotId: makeId('snapshot'),
			projectId,
			revision: 1,
			savedAt: createdAt,
			reason: 'create',
			contentHash: projectContentHash(state),
			state,
		};
		const project: ProjectRecord = {
			projectId,
			name: input.name.trim(),
			schemaVersion: PROJECT_SCHEMA_VERSION,
			createdAt,
			updatedAt: createdAt,
			lastOpenedAt: createdAt,
			currentSnapshotId: snapshot.snapshotId,
			currentRevision: snapshot.revision,
			archived: false,
		};

		await runTransaction(
			[PROJECT_STORE_PROJECTS, PROJECT_STORE_SNAPSHOTS],
			'readwrite',
			async (transaction) => {
				const projects = transaction.objectStore(PROJECT_STORE_PROJECTS);
				const snapshots = transaction.objectStore(PROJECT_STORE_SNAPSHOTS);
				await requestResult(projects.add(project));
				await requestResult(snapshots.add(snapshot));
			},
		);
		return clone(project);
	}

	async listProjects(
		options: ListProjectsOptions = {},
	): Promise<ProjectRecord[]> {
		return runTransaction(
			[PROJECT_STORE_PROJECTS],
			'readonly',
			async (transaction) => {
				const projects = (await requestResult(
					transaction.objectStore(PROJECT_STORE_PROJECTS).getAll(),
				)) as ProjectRecord[];
				return projects
					.filter((project) => {
						if (options.archived !== undefined) {
							return project.archived === options.archived;
						}
						return options.includeArchived === false ? !project.archived : true;
					})
					.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
					.map(clone);
			},
		);
	}

	async getProject(projectId: string): Promise<ProjectRecord | null> {
		return runTransaction(
			[PROJECT_STORE_PROJECTS],
			'readonly',
			async (transaction) => {
				const project = await requestResult(
					transaction.objectStore(PROJECT_STORE_PROJECTS).get(projectId),
				);
				return project ? clone(project as ProjectRecord) : null;
			},
		);
	}

	/** Marks a project as recently opened without changing its content revision. */
	async openProject(projectId: string): Promise<ProjectRecord> {
		return runTransaction(
			[PROJECT_STORE_PROJECTS],
			'readwrite',
			async (transaction) => {
				const store = transaction.objectStore(PROJECT_STORE_PROJECTS);
				const project = (await requestResult(store.get(projectId))) as
					| ProjectRecord
					| undefined;
				if (!project) {
					throw new ProjectStorageError(
						'not-found',
						`Project ${projectId} was not found.`,
					);
				}
				const updated = {...project, lastOpenedAt: nowIso()};
				await requestResult(store.put(updated));
				return clone(updated);
			},
		);
	}

	async renameProject(projectId: string, name: string): Promise<ProjectRecord> {
		validateName(name);
		return runTransaction(
			[PROJECT_STORE_PROJECTS],
			'readwrite',
			async (transaction) => {
				const store = transaction.objectStore(PROJECT_STORE_PROJECTS);
				const project = (await requestResult(store.get(projectId))) as
					| ProjectRecord
					| undefined;
				if (!project) {
					throw new ProjectStorageError(
						'not-found',
						`Project ${projectId} was not found.`,
					);
				}
				const updated = {...project, name: name.trim(), updatedAt: nowIso()};
				await requestResult(store.put(updated));
				return clone(updated);
			},
		);
	}

	async duplicateProject(
		projectId: string,
		name: string,
	): Promise<ProjectRecord> {
		const snapshot = await this.getCurrentSnapshot(projectId);
		if (!snapshot) {
			throw new ProjectStorageError(
				'not-found',
				`Project ${projectId} has no current snapshot.`,
			);
		}
		return this.createProject({name, state: clone(snapshot.state)});
	}

	async archiveProject(projectId: string): Promise<void> {
		await this.setArchived(projectId, true);
	}

	async restoreProject(projectId: string): Promise<void> {
		await this.setArchived(projectId, false);
	}

	private async setArchived(
		projectId: string,
		archived: boolean,
	): Promise<void> {
		await runTransaction(
			[PROJECT_STORE_PROJECTS],
			'readwrite',
			async (transaction) => {
				const store = transaction.objectStore(PROJECT_STORE_PROJECTS);
				const project = (await requestResult(store.get(projectId))) as
					| ProjectRecord
					| undefined;
				if (!project) {
					throw new ProjectStorageError(
						'not-found',
						`Project ${projectId} was not found.`,
					);
				}
				await requestResult(
					store.put({...project, archived, updatedAt: nowIso()}),
				);
			},
		);
	}

	async deleteProject(projectId: string): Promise<void> {
		await runTransaction(
			[
				PROJECT_STORE_PROJECTS,
				PROJECT_STORE_SNAPSHOTS,
				PROJECT_STORE_DRAFTS,
				PROJECT_STORE_RENDER_JOBS,
			],
			'readwrite',
			async (transaction) => {
				const projects = transaction.objectStore(PROJECT_STORE_PROJECTS);
				if (!(await requestResult(projects.get(projectId)))) {
					throw new ProjectStorageError(
						'not-found',
						`Project ${projectId} was not found.`,
					);
				}
				await requestResult(projects.delete(projectId));
				for (const storeName of [
					PROJECT_STORE_SNAPSHOTS,
					PROJECT_STORE_RENDER_JOBS,
				]) {
					const store = transaction.objectStore(storeName);
					const records = (await requestResult(store.getAll())) as Array<{
						projectId?: string;
						jobId?: string;
						snapshotId?: string;
					}>;
					for (const record of records.filter(
						(candidate) => candidate.projectId === projectId,
					)) {
						await requestResult(
							store.delete(record.snapshotId ?? record.jobId ?? ''),
						);
					}
				}
				await requestResult(
					transaction.objectStore(PROJECT_STORE_DRAFTS).delete(projectId),
				);
			},
		);
	}

	async writeSnapshot(
		snapshot: ProjectSnapshot | SnapshotInput,
	): Promise<void> {
		assertStorageAvailable();
		const state = normalizeUndoableState(clone(snapshot.state));
		const normalizedSnapshot: ProjectSnapshot = isCompleteSnapshot(snapshot)
			? {...clone(snapshot), state, contentHash: projectContentHash(state)}
			: {
					snapshotId: snapshot.snapshotId ?? makeId('snapshot'),
					projectId: snapshot.projectId,
					revision: snapshot.revision ?? 0,
					savedAt: snapshot.savedAt ?? nowIso(),
					reason: snapshot.reason,
					contentHash: projectContentHash(state),
					state,
				};
		await this.writeSnapshotInternal(normalizedSnapshot);
	}

	async saveSnapshot(input: SnapshotInput): Promise<ProjectSnapshot | null> {
		assertStorageAvailable();
		const state = normalizeUndoableState(clone(input.state));
		const snapshot: ProjectSnapshot = {
			snapshotId: input.snapshotId ?? makeId('snapshot'),
			projectId: input.projectId,
			revision: input.revision ?? 0,
			savedAt: input.savedAt ?? nowIso(),
			reason: input.reason,
			contentHash: projectContentHash(state),
			state,
		};
		const written = await this.writeSnapshotInternal(snapshot);
		return written ? clone(written) : null;
	}

	private async writeSnapshotInternal(
		snapshot: ProjectSnapshot,
	): Promise<ProjectSnapshot | null> {
		return runTransaction(
			[PROJECT_STORE_PROJECTS, PROJECT_STORE_SNAPSHOTS, PROJECT_STORE_DRAFTS],
			'readwrite',
			async (transaction) => {
				const projects = transaction.objectStore(PROJECT_STORE_PROJECTS);
				const snapshots = transaction.objectStore(PROJECT_STORE_SNAPSHOTS);
				const drafts = transaction.objectStore(PROJECT_STORE_DRAFTS);
				const project = (await requestResult(
					projects.get(snapshot.projectId),
				)) as ProjectRecord | undefined;
				if (!project) {
					throw new ProjectStorageError(
						'not-found',
						`Project ${snapshot.projectId} was not found.`,
					);
				}

				const existingSnapshots = await allSnapshots(
					snapshots,
					snapshot.projectId,
				);
				const existingWithId = existingSnapshots.find(
					(candidate) => candidate.snapshotId === snapshot.snapshotId,
				);
				if (existingWithId) {
					throw new ProjectStorageError(
						'invalid',
						`Snapshot ${snapshot.snapshotId} already exists and snapshots are immutable.`,
					);
				}
				if (
					automaticReason(snapshot.reason) &&
					existingSnapshots.some(
						(candidate) => candidate.contentHash === snapshot.contentHash,
					)
				) {
					return null;
				}

				const nextSnapshot: ProjectSnapshot = {
					...clone(snapshot),
					revision: Math.max(snapshot.revision, project.currentRevision + 1),
				};
				await requestResult(snapshots.put(nextSnapshot));
				const updatedProject: ProjectRecord = {
					...project,
					updatedAt: nextSnapshot.savedAt,
					currentSnapshotId: nextSnapshot.snapshotId,
					currentRevision: nextSnapshot.revision,
				};
				await requestResult(projects.put(updatedProject));
				await requestResult(drafts.delete(snapshot.projectId));
				await purgeAutomaticSnapshots(snapshots, snapshot.projectId);
				return nextSnapshot;
			},
		);
	}

	async getCurrentSnapshot(projectId: string): Promise<ProjectSnapshot | null> {
		return runTransaction(
			[PROJECT_STORE_PROJECTS, PROJECT_STORE_SNAPSHOTS],
			'readonly',
			async (transaction) => {
				const project = (await requestResult(
					transaction.objectStore(PROJECT_STORE_PROJECTS).get(projectId),
				)) as ProjectRecord | undefined;
				if (!project) {
					return null;
				}
				const snapshot = await requestResult(
					transaction
						.objectStore(PROJECT_STORE_SNAPSHOTS)
						.get(project.currentSnapshotId),
				);
				return snapshot ? clone(snapshot as ProjectSnapshot) : null;
			},
		);
	}

	async getSnapshot(snapshotId: string): Promise<ProjectSnapshot | null> {
		return runTransaction(
			[PROJECT_STORE_SNAPSHOTS],
			'readonly',
			async (transaction) => {
				const snapshot = await requestResult(
					transaction.objectStore(PROJECT_STORE_SNAPSHOTS).get(snapshotId),
				);
				return snapshot ? clone(snapshot as ProjectSnapshot) : null;
			},
		);
	}

	async listSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
		return runTransaction(
			[PROJECT_STORE_SNAPSHOTS],
			'readonly',
			async (transaction) =>
				(
					await allSnapshots(
						transaction.objectStore(PROJECT_STORE_SNAPSHOTS),
						projectId,
					)
				).map(clone),
		);
	}

	async deleteSnapshot(snapshotId: string): Promise<void> {
		await runTransaction(
			[PROJECT_STORE_PROJECTS, PROJECT_STORE_SNAPSHOTS],
			'readwrite',
			async (transaction) => {
				const snapshots = transaction.objectStore(PROJECT_STORE_SNAPSHOTS);
				const snapshot = (await requestResult(snapshots.get(snapshotId))) as
					| ProjectSnapshot
					| undefined;
				if (!snapshot) {
					return;
				}
				const project = (await requestResult(
					transaction
						.objectStore(PROJECT_STORE_PROJECTS)
						.get(snapshot.projectId),
				)) as ProjectRecord | undefined;
				if (project?.currentSnapshotId === snapshotId) {
					throw new ProjectStorageError(
						'invalid',
						'The current project snapshot cannot be deleted.',
					);
				}
				await requestResult(snapshots.delete(snapshotId));
			},
		);
	}

	async writeDraft(draft: DraftRecord): Promise<void> {
		assertStorageAvailable();
		const state = normalizeUndoableState(clone(draft.state));
		const normalizedDraft: DraftRecord = {
			...clone(draft),
			state,
			contentHash: projectContentHash(state),
		};
		await runTransaction(
			[PROJECT_STORE_PROJECTS, PROJECT_STORE_DRAFTS],
			'readwrite',
			async (transaction) => {
				const project = await requestResult(
					transaction.objectStore(PROJECT_STORE_PROJECTS).get(draft.projectId),
				);
				if (!project) {
					throw new ProjectStorageError(
						'not-found',
						`Project ${draft.projectId} was not found.`,
					);
				}
				await requestResult(
					transaction.objectStore(PROJECT_STORE_DRAFTS).put(normalizedDraft),
				);
			},
		);
	}

	async getDraft(projectId: string): Promise<DraftRecord | null> {
		return runTransaction(
			[PROJECT_STORE_DRAFTS],
			'readonly',
			async (transaction) => {
				const draft = await requestResult(
					transaction.objectStore(PROJECT_STORE_DRAFTS).get(projectId),
				);
				return draft ? clone(draft as DraftRecord) : null;
			},
		);
	}

	async deleteDraft(projectId: string): Promise<void> {
		await runTransaction(
			[PROJECT_STORE_DRAFTS],
			'readwrite',
			async (transaction) => {
				await requestResult(
					transaction.objectStore(PROJECT_STORE_DRAFTS).delete(projectId),
				);
			},
		);
	}

	async createRenderJob(job: RenderJob): Promise<RenderJob> {
		assertStorageAvailable();
		await runTransaction(
			[
				PROJECT_STORE_PROJECTS,
				PROJECT_STORE_SNAPSHOTS,
				PROJECT_STORE_RENDER_JOBS,
			],
			'readwrite',
			async (transaction) => {
				const projects = transaction.objectStore(PROJECT_STORE_PROJECTS);
				if (!(await requestResult(projects.get(job.projectId)))) {
					throw new ProjectStorageError(
						'not-found',
						`Project ${job.projectId} was not found.`,
					);
				}
				const snapshot = (await requestResult(
					transaction
						.objectStore(PROJECT_STORE_SNAPSHOTS)
						.get(job.inputSnapshotId),
				)) as ProjectSnapshot | undefined;
				if (
					!snapshot ||
					snapshot.projectId !== job.projectId ||
					snapshot.contentHash !== job.inputContentHash ||
					(job.inputRevision !== undefined &&
						snapshot.revision !== job.inputRevision)
				) {
					throw new ProjectStorageError(
						'invalid',
						'RenderJob input snapshot does not match its content hash or project.',
					);
				}
				await requestResult(
					transaction.objectStore(PROJECT_STORE_RENDER_JOBS).add(clone(job)),
				);
			},
		);
		return clone(job);
	}

	async getRenderJob(jobId: string): Promise<RenderJob | null> {
		return runTransaction(
			[PROJECT_STORE_RENDER_JOBS],
			'readonly',
			async (transaction) => {
				const job = await requestResult(
					transaction.objectStore(PROJECT_STORE_RENDER_JOBS).get(jobId),
				);
				return job ? clone(job as RenderJob) : null;
			},
		);
	}

	async listRenderJobs(
		projectId: string,
		options: {includeTerminal?: boolean} = {},
	): Promise<RenderJob[]> {
		return runTransaction(
			[PROJECT_STORE_RENDER_JOBS],
			'readonly',
			async (transaction) => {
				const records = (await requestResult(
					transaction.objectStore(PROJECT_STORE_RENDER_JOBS).getAll(),
				)) as RenderJob[];
				return records
					.filter(
						(job) =>
							job.projectId === projectId &&
							((options.includeTerminal ?? true)
								? true
								: !['succeeded', 'failed', 'canceled'].includes(job.status)),
					)
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
					.map(clone);
			},
		);
	}

	async updateRenderJob(
		jobId: string,
		updater: (job: RenderJob) => RenderJob,
	): Promise<RenderJob> {
		return runTransaction(
			[PROJECT_STORE_RENDER_JOBS],
			'readwrite',
			async (transaction) => {
				const store = transaction.objectStore(PROJECT_STORE_RENDER_JOBS);
				const existing = (await requestResult(store.get(jobId))) as
					| RenderJob
					| undefined;
				if (!existing) {
					throw new ProjectStorageError(
						'not-found',
						`RenderJob ${jobId} was not found.`,
					);
				}
				const next = updater(clone(existing));
				if (
					next.jobId !== existing.jobId ||
					next.projectId !== existing.projectId
				) {
					throw new ProjectStorageError(
						'invalid',
						'RenderJob identity cannot be changed.',
					);
				}
				await requestResult(store.put(clone(next)));
				return clone(next);
			},
		);
	}

	async putRenderJob(job: RenderJob): Promise<RenderJob> {
		return this.updateRenderJob(job.jobId, () => job);
	}

	async deleteRenderJob(jobId: string): Promise<void> {
		await runTransaction(
			[PROJECT_STORE_RENDER_JOBS],
			'readwrite',
			async (transaction) => {
				await requestResult(
					transaction.objectStore(PROJECT_STORE_RENDER_JOBS).delete(jobId),
				);
			},
		);
	}

	async migrateLegacyState(): Promise<LegacyMigrationResult> {
		if (typeof localStorage === 'undefined') {
			return {status: 'none'};
		}
		const rawStateJson = localStorage.getItem(LEGACY_STATE_STORAGE_KEY);
		if (!rawStateJson) {
			return {status: 'none'};
		}
		const migratedProjectId = localStorage.getItem(
			LEGACY_MIGRATION_PROJECT_KEY,
		);
		if (migratedProjectId) {
			try {
				const project = await this.getProject(migratedProjectId);
				if (project) {
					return {status: 'migrated', project, rawStateJson};
				}
			} catch (error) {
				return {
					status: 'failed',
					rawStateJson,
					error: error instanceof Error ? error : new Error(String(error)),
				};
			}
		}

		try {
			const state = JSON.parse(rawStateJson) as UndoableState;
			if (!state || typeof state !== 'object' || !Array.isArray(state.tracks)) {
				throw new Error(
					'Legacy project JSON does not contain a valid editor state.',
				);
			}
			const project = await this.createProject({
				name: 'Migrated project',
				state,
			});
			localStorage.setItem(LEGACY_MIGRATION_PROJECT_KEY, project.projectId);
			return {status: 'migrated', project, rawStateJson};
		} catch (error) {
			return {
				status: 'failed',
				rawStateJson,
				error: error instanceof Error ? error : new Error(String(error)),
			};
		}
	}
}

export const projectStore = new ProjectStore();

export const createProject = (input: CreateProjectInput) =>
	projectStore.createProject(input);
export const listProjects = (options?: ListProjectsOptions) =>
	projectStore.listProjects(options);
export const getProject = (projectId: string) =>
	projectStore.getProject(projectId);
export const openProject = (projectId: string) =>
	projectStore.openProject(projectId);
export const renameProject = (projectId: string, name: string) =>
	projectStore.renameProject(projectId, name);
export const duplicateProject = (projectId: string, name: string) =>
	projectStore.duplicateProject(projectId, name);
export const archiveProject = (projectId: string) =>
	projectStore.archiveProject(projectId);
export const restoreProject = (projectId: string) =>
	projectStore.restoreProject(projectId);
export const deleteProject = (projectId: string) =>
	projectStore.deleteProject(projectId);
export const writeSnapshot = (snapshot: ProjectSnapshot | SnapshotInput) =>
	projectStore.writeSnapshot(snapshot);
export const saveSnapshot = (input: SnapshotInput) =>
	projectStore.saveSnapshot(input);
export const getCurrentSnapshot = (projectId: string) =>
	projectStore.getCurrentSnapshot(projectId);
export const getSnapshot = (snapshotId: string) =>
	projectStore.getSnapshot(snapshotId);
export const listSnapshots = (projectId: string) =>
	projectStore.listSnapshots(projectId);
export const deleteSnapshot = (snapshotId: string) =>
	projectStore.deleteSnapshot(snapshotId);
export const writeDraft = (draft: DraftRecord) =>
	projectStore.writeDraft(draft);
export const getDraft = (projectId: string) => projectStore.getDraft(projectId);
export const deleteDraft = (projectId: string) =>
	projectStore.deleteDraft(projectId);
export const createRenderJob = (job: RenderJob) =>
	projectStore.createRenderJob(job);
export const getRenderJob = (jobId: string) => projectStore.getRenderJob(jobId);
export const listRenderJobs = (
	projectId: string,
	options?: {includeTerminal?: boolean},
) => projectStore.listRenderJobs(projectId, options);
export const updateRenderJob = (
	jobId: string,
	updater: (job: RenderJob) => RenderJob,
) => projectStore.updateRenderJob(jobId, updater);
export const putRenderJob = (job: RenderJob) => projectStore.putRenderJob(job);
export const deleteRenderJob = (jobId: string) =>
	projectStore.deleteRenderJob(jobId);
export const migrateLegacyState = () => projectStore.migrateLegacyState();

/** Tests and hot-reload callers can release the cached connection without touching data. */
export const resetProjectDatabaseConnection = () => {
	databasePromise?.then((database) => database.close()).catch(() => undefined);
	databasePromise = null;
};
