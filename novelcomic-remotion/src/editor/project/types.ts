import type {UndoableState} from '../state/types';

/** The project storage schema is intentionally independent from the editor runtime schema. */
export const PROJECT_SCHEMA_VERSION = 3 as const;

export type SnapshotReason =
	| 'create'
	| 'command'
	| 'autosave'
	| 'manual'
	| 'restore'
	| 'import';

export type ProjectRecord = {
	projectId: string;
	name: string;
	schemaVersion: typeof PROJECT_SCHEMA_VERSION;
	createdAt: string;
	updatedAt: string;
	lastOpenedAt: string;
	currentSnapshotId: string;
	currentRevision: number;
	archived: boolean;
};

export type ProjectSnapshot = {
	snapshotId: string;
	projectId: string;
	revision: number;
	savedAt: string;
	reason: SnapshotReason;
	contentHash: string;
	state: UndoableState;
};

export type DraftRecord = {
	projectId: string;
	draftId?: string;
	updatedAt: string;
	savedAt?: string;
	contentHash: string;
	state: UndoableState;
};

export type CreateProjectInput = {
	name: string;
	state?: UndoableState;
	projectId?: string;
	createdAt?: string;
};

export type SnapshotInput = {
	projectId: string;
	state: UndoableState;
	reason: SnapshotReason;
	snapshotId?: string;
	savedAt?: string;
	contentHash?: string;
	revision?: number;
};

export type ListProjectsOptions = {
	includeArchived?: boolean;
	archived?: boolean;
};

export type LegacyMigrationResult =
	| {status: 'none'}
	| {status: 'migrated'; project: ProjectRecord; rawStateJson: string}
	| {status: 'failed'; rawStateJson: string; error: Error};
