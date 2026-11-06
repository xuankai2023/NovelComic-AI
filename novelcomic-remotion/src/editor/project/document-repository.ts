import type {DocumentCommand} from '../commands/document-command-types';
import {
	canonicalDocumentJson,
	normalizeDocument,
	type DocumentState,
} from '../document';

export type DocumentProjectRecord = {
	projectId: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	currentRevision: number;
	currentSnapshotId: string;
	schemaVersion: 1;
	archived: boolean;
};
export type DocumentSnapshot = {
	snapshotId: string;
	projectId: string;
	revision: number;
	savedAt: string;
	reason: 'create' | 'command' | 'autosave' | 'manual' | 'restore';
	contentHash?: string;
	document: DocumentState;
};
export type DocumentDraft = {
	projectId: string;
	updatedAt: string;
	document: DocumentState;
	contentHash?: string;
};
export type DocumentCommitResult = {
	project: DocumentProjectRecord;
	snapshot: DocumentSnapshot;
	document: DocumentState;
};

export class RevisionConflictError extends Error {
	readonly code = 'REVISION_CONFLICT';
	constructor(
		readonly expectedRevision: number,
		readonly actualRevision: number,
		readonly currentSnapshot: DocumentSnapshot | null,
		readonly localDocument: DocumentState,
	) {
		super(
			`Revision conflict: expected ${expectedRevision}, actual ${actualRevision}`,
		);
		this.name = 'RevisionConflictError';
	}
}
export class IdempotencyKeyReusedError extends Error {
	readonly code = 'IDEMPOTENCY_KEY_REUSED';
	constructor() {
		super('The requestId was already used with a different command payload');
		this.name = 'IdempotencyKeyReusedError';
	}
}
export class DocumentRepositoryError extends Error {
	constructor(
		readonly code: 'unavailable' | 'not-found' | 'transaction-failed',
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'DocumentRepositoryError';
	}
}

export interface DocumentRepository {
	createProject(
		projectId: string,
		document: DocumentState,
	): Promise<DocumentProjectRecord>;
	listProjects(): Promise<DocumentProjectRecord[]>;
	getProject(projectId: string): Promise<DocumentProjectRecord | null>;
	getCurrentSnapshot(projectId: string): Promise<DocumentSnapshot | null>;
	listSnapshots(projectId: string): Promise<DocumentSnapshot[]>;
	getDraft(projectId: string): Promise<DocumentDraft | null>;
	writeDraft(
		projectId: string,
		document: DocumentState,
	): Promise<DocumentDraft>;
	deleteDraft(projectId: string): Promise<void>;
	commit(
		command: DocumentCommand,
		document: DocumentState,
		reason?: DocumentSnapshot['reason'],
	): Promise<DocumentCommitResult>;
	restoreSnapshot(
		projectId: string,
		snapshotId: string,
		expectedRevision: number,
		requestId?: string,
	): Promise<DocumentCommitResult>;
}

export const DOCUMENT_DB_NAME = 'novelcomic-remotion-document-v1';
export const DOCUMENT_DB_VERSION = 1;
export const DOCUMENT_STORES = {
	projects: 'projects',
	snapshots: 'snapshots',
	drafts: 'drafts',
	requests: 'requests',
} as const;
type RequestRecord = {
	key: string;
	projectId: string;
	requestId: string;
	payloadHash: string;
	result: DocumentCommitResult;
};

const id = (prefix: string) =>
	`${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const now = () => new Date().toISOString();
const stableJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(',')}}`;
	return JSON.stringify(Object.is(value, -0) ? 0 : value);
};
const request = <T>(source: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		source.onsuccess = () => resolve(source.result);
		source.onerror = () =>
			reject(source.error ?? new Error('IndexedDB request failed'));
	});
const complete = (tx: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () =>
			reject(tx.error ?? new Error('IndexedDB transaction failed'));
		tx.onabort = () =>
			reject(tx.error ?? new Error('IndexedDB transaction aborted'));
	});

export class IndexedDBDocumentRepository implements DocumentRepository {
	private dbPromise: Promise<IDBDatabase> | null = null;
	private open() {
		if (typeof indexedDB === 'undefined')
			return Promise.reject(
				new DocumentRepositoryError('unavailable', 'IndexedDB is unavailable'),
			);
		if (this.dbPromise) return this.dbPromise;
		this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
			const open = indexedDB.open(DOCUMENT_DB_NAME, DOCUMENT_DB_VERSION);
			open.onupgradeneeded = () => {
				const db = open.result;
				const tx = open.transaction!;
				const projects = db.objectStoreNames.contains(DOCUMENT_STORES.projects)
					? tx.objectStore(DOCUMENT_STORES.projects)
					: db.createObjectStore(DOCUMENT_STORES.projects, {
							keyPath: 'projectId',
						});
				const snapshots = db.objectStoreNames.contains(
					DOCUMENT_STORES.snapshots,
				)
					? tx.objectStore(DOCUMENT_STORES.snapshots)
					: db.createObjectStore(DOCUMENT_STORES.snapshots, {
							keyPath: 'snapshotId',
						});
				if (!snapshots.indexNames.contains('projectIdRevision'))
					snapshots.createIndex('projectIdRevision', ['projectId', 'revision']);
				if (!snapshots.indexNames.contains('projectId'))
					snapshots.createIndex('projectId', 'projectId');
				if (!db.objectStoreNames.contains(DOCUMENT_STORES.drafts))
					db.createObjectStore(DOCUMENT_STORES.drafts, {keyPath: 'projectId'});
				const requests = db.objectStoreNames.contains(DOCUMENT_STORES.requests)
					? tx.objectStore(DOCUMENT_STORES.requests)
					: db.createObjectStore(DOCUMENT_STORES.requests, {keyPath: 'key'});
				if (!requests.indexNames.contains('projectIdRequestId'))
					requests.createIndex(
						'projectIdRequestId',
						['projectId', 'requestId'],
						{unique: true},
					);
				void projects;
			};
			open.onsuccess = () => resolve(open.result);
			open.onerror = () =>
				reject(
					new DocumentRepositoryError(
						'unavailable',
						'Unable to open document storage',
						open.error,
					),
				);
		});
		this.dbPromise = this.dbPromise.catch((error) => {
			this.dbPromise = null;
			throw error;
		});
		return this.dbPromise;
	}
	private async tx<T>(
		stores: string[],
		mode: IDBTransactionMode,
		fn: (tx: IDBTransaction) => Promise<T>,
	): Promise<T> {
		const db = await this.open();
		const transaction = db.transaction(stores, mode);
		const done = complete(transaction);
		try {
			const result = await fn(transaction);
			await done;
			return result;
		} catch (error) {
			try {
				transaction.abort();
			} catch {
				// The transaction may already be aborted; preserve the original error.
			}
			throw error;
		}
	}
	async createProject(projectId: string, document: DocumentState) {
		const normalized = normalizeDocument(document);
		const timestamp = now();
		const contentHash = await this.hash(normalized);
		const snapshot: DocumentSnapshot = {
			snapshotId: id('snapshot'),
			projectId,
			revision: 0,
			savedAt: timestamp,
			reason: 'create',
			document: normalized,
			contentHash,
		};
		const project: DocumentProjectRecord = {
			projectId,
			name: normalized.name,
			createdAt: timestamp,
			updatedAt: timestamp,
			currentRevision: 0,
			currentSnapshotId: snapshot.snapshotId,
			schemaVersion: 1,
			archived: false,
		};
		return this.tx(
			[DOCUMENT_STORES.projects, DOCUMENT_STORES.snapshots],
			'readwrite',
			async (tx) => {
				const existing = await request(
					tx.objectStore(DOCUMENT_STORES.projects).get(projectId),
				);
				if (existing)
					throw new DocumentRepositoryError(
						'transaction-failed',
						'Project already exists',
					);
				tx.objectStore(DOCUMENT_STORES.projects).put(project);
				tx.objectStore(DOCUMENT_STORES.snapshots).put(snapshot);
				return project;
			},
		);
	}
	async getProject(projectId: string) {
		return this.tx(
			[DOCUMENT_STORES.projects],
			'readonly',
			async (tx) =>
				(await request(
					tx.objectStore(DOCUMENT_STORES.projects).get(projectId),
				)) ?? null,
		);
	}
	async listProjects() {
		return this.tx([DOCUMENT_STORES.projects], 'readonly', async (tx) => {
			const projects = (await request(
				tx.objectStore(DOCUMENT_STORES.projects).getAll(),
			)) as DocumentProjectRecord[];
			return projects
				.filter((project) => !project.archived)
				.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		});
	}
	async getCurrentSnapshot(projectId: string) {
		const project = await this.getProject(projectId);
		if (!project) return null;
		return this.tx(
			[DOCUMENT_STORES.snapshots],
			'readonly',
			async (tx) =>
				(await request(
					tx
						.objectStore(DOCUMENT_STORES.snapshots)
						.get(project.currentSnapshotId),
				)) ?? null,
		);
	}
	async listSnapshots(projectId: string) {
		return this.tx([DOCUMENT_STORES.snapshots], 'readonly', async (tx) => {
			const index = tx
				.objectStore(DOCUMENT_STORES.snapshots)
				.index('projectIdRevision');
			const values = await request(
				index.getAll(
					IDBKeyRange.bound(
						[projectId, 0],
						[projectId, Number.MAX_SAFE_INTEGER],
					),
				),
			);
			return (values as DocumentSnapshot[]).sort(
				(a, b) => b.revision - a.revision,
			);
		});
	}
	async getDraft(projectId: string) {
		return this.tx(
			[DOCUMENT_STORES.drafts],
			'readonly',
			async (tx) =>
				(await request(
					tx.objectStore(DOCUMENT_STORES.drafts).get(projectId),
				)) ?? null,
		);
	}
	async writeDraft(projectId: string, document: DocumentState) {
		const draft: DocumentDraft = {
			projectId,
			updatedAt: now(),
			document: normalizeDocument(document),
		};
		draft.contentHash = await this.hash(draft.document);
		await this.tx([DOCUMENT_STORES.drafts], 'readwrite', async (tx) => {
			tx.objectStore(DOCUMENT_STORES.drafts).put(draft);
			return draft;
		});
		return draft;
	}
	async deleteDraft(projectId: string) {
		await this.tx([DOCUMENT_STORES.drafts], 'readwrite', async (tx) => {
			tx.objectStore(DOCUMENT_STORES.drafts).delete(projectId);
			return undefined;
		});
	}
	private async hash(document: DocumentState) {
		const data = new TextEncoder().encode(canonicalDocumentJson(document));
		const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
		return Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');
	}
	private async hashValue(value: unknown) {
		const data = new TextEncoder().encode(stableJson(value));
		const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
		return Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');
	}
	async commit(
		command: DocumentCommand,
		document: DocumentState,
		reason: DocumentSnapshot['reason'] = 'command',
	) {
		const normalized = normalizeDocument(document);
		const payloadHash = await this.hashValue(command.payload);
		const contentHash = await this.hash(normalized);
		return this.tx(
			[
				DOCUMENT_STORES.projects,
				DOCUMENT_STORES.snapshots,
				DOCUMENT_STORES.drafts,
				DOCUMENT_STORES.requests,
			],
			'readwrite',
			async (tx) => {
				const projects = tx.objectStore(DOCUMENT_STORES.projects);
				const snapshots = tx.objectStore(DOCUMENT_STORES.snapshots);
				const requests = tx.objectStore(DOCUMENT_STORES.requests);
				const key = `${command.projectId}:${command.requestId}`;
				const previous = await request<RequestRecord | undefined>(
					requests.get(key),
				);
				if (previous) {
					if (previous.payloadHash !== payloadHash)
						throw new IdempotencyKeyReusedError();
					return previous.result;
				}
				const project = await request<DocumentProjectRecord | undefined>(
					projects.get(command.projectId),
				);
				if (!project)
					throw new DocumentRepositoryError(
						'not-found',
						'Project does not exist',
					);
				if (project.currentRevision !== command.expectedRevision) {
					const current = await request<DocumentSnapshot | undefined>(
						snapshots.get(project.currentSnapshotId),
					);
					throw new RevisionConflictError(
						command.expectedRevision,
						project.currentRevision,
						current ?? null,
						normalized,
					);
				}
				const timestamp = now();
				const snapshot: DocumentSnapshot = {
					snapshotId: id('snapshot'),
					projectId: command.projectId,
					revision: project.currentRevision + 1,
					savedAt: timestamp,
					reason,
					document: normalized,
					contentHash,
				};
				const nextProject = {
					...project,
					name: normalized.name,
					updatedAt: timestamp,
					currentRevision: snapshot.revision,
					currentSnapshotId: snapshot.snapshotId,
				};
				const result = {project: nextProject, snapshot, document: normalized};
				projects.put(nextProject);
				snapshots.put(snapshot);
				tx.objectStore(DOCUMENT_STORES.drafts).delete(command.projectId);
				requests.put({
					key,
					projectId: command.projectId,
					requestId: command.requestId,
					payloadHash,
					result,
				} satisfies RequestRecord);
				return result;
			},
		);
	}
	async restoreSnapshot(
		projectId: string,
		snapshotId: string,
		expectedRevision: number,
		requestId = id('restore-request'),
	) {
		const snapshot = await this.tx(
			[DOCUMENT_STORES.snapshots],
			'readonly',
			async (tx) =>
				request<DocumentSnapshot | undefined>(
					tx.objectStore(DOCUMENT_STORES.snapshots).get(snapshotId),
				),
		);
		if (!snapshot || snapshot.projectId !== projectId)
			throw new DocumentRepositoryError('not-found', 'Snapshot does not exist');
		return this.commit(
			{
				id: id('restore'),
				requestId,
				projectId,
				expectedRevision,
				type: 'project.replace',
				payload: {document: snapshot.document},
				createdAt: now(),
			},
			snapshot.document,
			'restore',
		);
	}
}
