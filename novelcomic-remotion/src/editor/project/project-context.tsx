'use client';

import React, {
	createContext,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {getKeys} from '../caching/indexeddb';
import {loadToBlobUrlOnce} from '../caching/load-to-blob-url';
import {
	cleanUpAssetStatus,
	cleanUpStateBeforeSaving,
} from '../state/clean-up-state-before-saving';
import {normalizeUndoableState} from '../state/normalize-undoable-state';
import type {EditorState, UndoableState} from '../state/types';
import {updateAssetStatusAfterCleanup} from '../utils/asset-cleanup-utils';
import {
	createAssetStatusFromUndoableState,
	hasAssetsWithErrors,
} from '../utils/asset-status-utils';
import {hasUploadingAssets} from '../utils/upload-status';
import {
	createAutosaveScheduler,
	type AutosaveScheduler,
} from './autosave-controller';
import {browserProjectHash} from './browser-project-hash';
import {
	renderJobToRenderingTask,
} from '../rendering/render-state';
import {renderJobStore} from '../rendering/render-job-store';
import {
	resumeRenderJobPolling,
	stopProjectRenderPolling,
} from '../rendering/render-job-runtime';
import type {RenderJob} from '../rendering/render-job-types';
import {ProjectListPanel} from './project-list-panel';
import {
	getCurrentSnapshot,
	getDraft,
	getProject,
	listProjects,
	listSnapshots,
	migrateLegacyState,
	saveSnapshot,
	archiveProject as storeArchiveProject,
	createProject as storeCreateProject,
	deleteDraft as storeDeleteDraft,
	deleteProject as storeDeleteProject,
	deleteSnapshot as storeDeleteSnapshot,
	duplicateProject as storeDuplicateProject,
	openProject as storeOpenProject,
	renameProject as storeRenameProject,
	restoreProject as storeRestoreProject,
	writeDraft,
} from './project-store';
import {RecoveryDialog} from './recovery-dialog';
import type {
	DraftRecord,
	LegacyMigrationResult,
	ProjectRecord,
	ProjectSnapshot,
	SnapshotReason,
} from './types';
import {PROJECT_SCHEMA_VERSION} from './types';

export type ProjectSaveStatus =
	| 'idle'
	| 'dirty'
	| 'saving'
	| 'saved'
	| 'save-error'
	| 'recovery'
	| 'readonly';

export type ProjectContextValue = {
	activeProject: ProjectRecord | null;
	currentSnapshot: ProjectSnapshot | null;
	snapshots: ProjectSnapshot[];
	draft: DraftRecord | null;
	projects: ProjectRecord[];
	isLoading: boolean;
	isReadOnly: boolean;
	readOnlyReason: string | null;
	migrationFailure: (LegacyMigrationResult & {status: 'failed'}) | null;
	saveStatus: ProjectSaveStatus;
	saveError: string | null;
	openProject: (projectId: string) => Promise<void>;
	createProject: (name: string) => Promise<ProjectRecord | null>;
	renameProject: (projectId: string, name: string) => Promise<void>;
	duplicateProject: (
		projectId: string,
		name: string,
	) => Promise<ProjectRecord | null>;
	archiveProject: (projectId: string) => Promise<void>;
	restoreProject: (projectId: string) => Promise<void>;
	deleteProject: (projectId: string) => Promise<void>;
	refreshProjects: () => Promise<void>;
	saveNow: (
		reason?: Extract<SnapshotReason, 'manual' | 'autosave' | 'command'>,
	) => Promise<boolean>;
	retrySave: () => Promise<boolean>;
	importState: (state: UndoableState) => Promise<boolean>;
	restoreSnapshot: (snapshotId: string) => Promise<boolean>;
	deleteSnapshot: (snapshotId: string) => Promise<void>;
	restoreDraft: () => Promise<boolean>;
	discardDraft: () => Promise<void>;
	downloadDraft: () => void;
	downloadBackup: (snapshot?: ProjectSnapshot | null) => void;
	downloadMigrationBackup: () => void;
	openProjectList: () => void;
	closeProjectList: () => void;
	projectListOpen: boolean;
	openVersionList: () => void;
	closeVersionList: () => void;
	versionListOpen: boolean;
	unsupportedSchemaVersion: number | null;
};

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export const useProjectContext = () => {
	const context = React.useContext(ProjectContext);
	if (!context) throw new Error('ProjectContext is not set');
	return context;
};

type ProjectContextProviderProps = {
	state: EditorState;
	setEditorState: React.Dispatch<React.SetStateAction<EditorState>>;
	projectCommitRevision: number;
	resetCommandHistory: () => void;
	children: React.ReactNode;
};

const readProjectIdFromUrl = () => {
	if (typeof window === 'undefined') return null;
	return new URL(window.location.href).searchParams.get('projectId');
};

const writeProjectIdToUrl = (projectId: string | null, replace = false) => {
	if (typeof window === 'undefined') return;
	const url = new URL(window.location.href);
	if (projectId) url.searchParams.set('projectId', projectId);
	else url.searchParams.delete('projectId');
	if (replace) window.history.replaceState({}, '', url);
	else window.history.pushState({}, '', url);
};

const downloadJson = (filename: string, value: unknown) => {
	if (typeof document === 'undefined') return;
	const blob = new Blob([JSON.stringify(value, null, 2)], {
		type: 'application/json',
	});
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
};

const projectErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);
const stateSchemaVersion = (state: UndoableState) => state.schemaVersion ?? 1;
const isSchemaSupported = (state: UndoableState) =>
	stateSchemaVersion(state) <= PROJECT_SCHEMA_VERSION;
const stateFingerprint = browserProjectHash;
const isNewerDraft = (
	draft: DraftRecord | null,
	snapshot: ProjectSnapshot | null,
) =>
	Boolean(
		draft &&
		snapshot &&
		draft.updatedAt > snapshot.savedAt &&
		draft.contentHash !== snapshot.contentHash,
	);

export const ProjectContextProvider = ({
	state,
	setEditorState,
	projectCommitRevision,
	resetCommandHistory,
	children,
}: ProjectContextProviderProps) => {
	const [activeProject, setActiveProject] = useState<ProjectRecord | null>(
		null,
	);
	const [currentSnapshot, setCurrentSnapshot] =
		useState<ProjectSnapshot | null>(null);
	const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([]);
	const [draft, setDraft] = useState<DraftRecord | null>(null);
	const [projects, setProjects] = useState<ProjectRecord[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isReadOnly, setIsReadOnly] = useState(false);
	const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
	const [unsupportedSchemaVersion, setUnsupportedSchemaVersion] = useState<
		number | null
	>(null);
	const [migrationFailure, setMigrationFailure] = useState<
		(LegacyMigrationResult & {status: 'failed'}) | null
	>(null);
	const [saveStatus, setSaveStatus] = useState<ProjectSaveStatus>('idle');
	const [saveError, setSaveError] = useState<string | null>(null);
	const [projectListOpen, setProjectListOpen] = useState(false);
	const [versionListOpen, setVersionListOpen] = useState(false);

	const stateRef = useRef(state);
	stateRef.current = state;
	const activeProjectRef = useRef(activeProject);
	activeProjectRef.current = activeProject;
	const currentSnapshotRef = useRef(currentSnapshot);
	currentSnapshotRef.current = currentSnapshot;
	const persistedHashRef = useRef<string | null>(null);
	const skipNextStateEffectRef = useRef(false);
	const bootstrappedRef = useRef(false);
	const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
	const autosaveRef = useRef<AutosaveScheduler | null>(null);

	const loadAssetsFromCache = useCallback(
		async (assets: EditorState['undoableState']['assets']) => {
			if (typeof indexedDB === 'undefined') return;
			try {
				const keys = await getKeys();
				for (const asset of Object.values(assets)) {
					if (keys.includes(asset.id)) await loadToBlobUrlOnce(asset);
				}
			} catch {
				// Cache failures never invalidate an otherwise readable project snapshot.
			}
		},
		[],
	);

	const hydrateSnapshot = useCallback(
		async (snapshot: ProjectSnapshot) => {
			if (!isSchemaSupported(snapshot.state)) {
				throw new Error(
					`Project schema ${stateSchemaVersion(snapshot.state)} is newer than this editor supports (maximum ${PROJECT_SCHEMA_VERSION}).`,
				);
			}
			const normalized = normalizeUndoableState(snapshot.state);
			await loadAssetsFromCache(normalized.assets);
			const assetStatus = await createAssetStatusFromUndoableState(normalized);
			const updatedAssetStatus = updateAssetStatusAfterCleanup(
				assetStatus,
				normalized,
			);
			persistedHashRef.current = snapshot.contentHash;
			skipNextStateEffectRef.current = true;
			resetCommandHistory();
			setEditorState((previous) => ({
				...previous,
				undoableState: normalized,
				assetStatus: updatedAssetStatus,
				selectedItems: previous.selectedItems.filter(
					(id) => normalized.items[id],
				),
				textItemEditing: null,
				itemSelectedForCrop: null,
				initialized: true,
			}));
		},
		[loadAssetsFromCache, resetCommandHistory, setEditorState],
	);

	const refreshProjects = useCallback(async () => {
		setProjects(await listProjects({includeArchived: true}));
	}, []);

	const refreshActiveRecords = useCallback(async (projectId: string) => {
		const [project, snapshot, nextSnapshots, nextDraft] = await Promise.all([
			getProject(projectId),
			getCurrentSnapshot(projectId),
			listSnapshots(projectId),
			getDraft(projectId),
		]);
		return {project, snapshot, snapshots: nextSnapshots, draft: nextDraft};
	}, []);

	const commitLoadedRecords = useCallback(
		async ({
			project,
			snapshot,
			nextSnapshots,
			nextDraft,
		}: {
			project: ProjectRecord;
			snapshot: ProjectSnapshot;
			nextSnapshots: ProjectSnapshot[];
			nextDraft: DraftRecord | null;
		}) => {
			if (!isSchemaSupported(snapshot.state)) {
				setActiveProject(project);
				setCurrentSnapshot(snapshot);
				setSnapshots(nextSnapshots);
				setDraft(nextDraft);
				setUnsupportedSchemaVersion(stateSchemaVersion(snapshot.state));
				setReadOnlyReason(
					`此工程使用 schema ${stateSchemaVersion(snapshot.state)}，当前编辑器最高支持 ${PROJECT_SCHEMA_VERSION}。请下载备份或升级编辑器。`,
				);
				setIsReadOnly(true);
				setSaveStatus('readonly');
				return;
			}
			setUnsupportedSchemaVersion(null);
			setReadOnlyReason(null);
			setIsReadOnly(false);
			setActiveProject(project);
			activeProjectRef.current = project;
			setCurrentSnapshot(snapshot);
			setSnapshots(nextSnapshots);
			setDraft(nextDraft);
			await hydrateSnapshot(snapshot);
			setSaveError(null);
			setSaveStatus(isNewerDraft(nextDraft, snapshot) ? 'recovery' : 'saved');
		},
		[hydrateSnapshot],
	);

	const activateProject = useCallback(
		async (projectId: string, updateUrl = true) => {
			setIsLoading(true);
			setVersionListOpen(false);
			setProjectListOpen(false);
			setReadOnlyReason(null);
			try {
				const opened = await storeOpenProject(projectId);
				const records = await refreshActiveRecords(projectId);
				if (!records.snapshot)
					throw new Error(
						`Project ${projectId} does not have a current snapshot.`,
					);
				if (updateUrl) writeProjectIdToUrl(projectId);
				await commitLoadedRecords({
					project: opened,
					snapshot: records.snapshot,
					nextSnapshots: records.snapshots,
					nextDraft: records.draft,
				});
				activeProjectRef.current = opened;
				await refreshProjects();
			} catch (error) {
				setIsReadOnly(true);
				setReadOnlyReason(projectErrorMessage(error));
				setSaveStatus('readonly');
			} finally {
				setIsLoading(false);
			}
		},
		[commitLoadedRecords, refreshActiveRecords, refreshProjects],
	);

	useEffect(() => {
		if (bootstrappedRef.current) return;
		bootstrappedRef.current = true;
		let cancelled = false;
		const bootstrap = async () => {
			setIsLoading(true);
			try {
				let nextProjects = await listProjects({includeArchived: true});
				let migration: LegacyMigrationResult = {status: 'none'};
				if (nextProjects.length === 0) {
					migration = await migrateLegacyState();
					if (migration.status === 'failed') setMigrationFailure(migration);
					nextProjects = await listProjects({includeArchived: true});
				}
				if (cancelled) return;
				setProjects(nextProjects);
				const requestedId = readProjectIdFromUrl();
				const requested = requestedId
					? nextProjects.find((project) => project.projectId === requestedId)
					: null;
				const migrated =
					migration.status === 'migrated' ? migration.project : null;
				const recent = nextProjects.find((project) => !project.archived);
				const selected = requested ?? migrated ?? recent;
				if (selected) await activateProject(selected.projectId, !requested);
				else {
					setEditorState((previous) => ({...previous, initialized: false}));
					setProjectListOpen(true);
					setSaveStatus('idle');
				}
			} catch (error) {
				if (!cancelled) {
					setIsReadOnly(true);
					setReadOnlyReason(projectErrorMessage(error));
					setSaveStatus('readonly');
				}
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		};
		void bootstrap();
		return () => {
			cancelled = true;
		};
	}, [activateProject, setEditorState]);

	const enqueueSave = useCallback(
		(reason: Extract<SnapshotReason, 'manual' | 'autosave' | 'command'>) => {
			const operation = async (): Promise<boolean> => {
				const project = activeProjectRef.current;
				if (!project || isReadOnly) return false;
				const cleaned = cleanUpAssetStatus(stateRef.current);
				const stateToSave = cleanUpStateBeforeSaving(cleaned.undoableState);
				const contentHash = stateFingerprint(stateToSave);
				const blockedByAssets =
					hasUploadingAssets(cleaned.assetStatus) ||
					hasAssetsWithErrors(cleaned.assetStatus);
				setSaveStatus('saving');
				setSaveError(null);
				if (blockedByAssets) {
					try {
						const nextDraft: DraftRecord = {
							projectId: project.projectId,
							draftId: `draft-${project.projectId}`,
							updatedAt: new Date().toISOString(),
							contentHash,
							state: stateToSave,
						};
						await writeDraft(nextDraft);
						setDraft(nextDraft);
						setSaveStatus('dirty');
						setSaveError(
							hasUploadingAssets(cleaned.assetStatus)
								? '素材上传中，编辑已保存在草稿中。'
								: '素材存在错误，编辑已保存在草稿中。',
						);
					} catch (error) {
						setSaveStatus('save-error');
						setSaveError(projectErrorMessage(error));
					}
					return false;
				}
				try {
					const written = await saveSnapshot({
						projectId: project.projectId,
						state: stateToSave,
						reason,
					});
					const latestSnapshot =
						written ?? (await getCurrentSnapshot(project.projectId));
					if (!latestSnapshot)
						throw new Error(
							'The project current snapshot could not be read after saving.',
						);
					const latestProject = await getProject(project.projectId);
					const latestSnapshots = await listSnapshots(project.projectId);
					persistedHashRef.current = latestSnapshot.contentHash;
					setCurrentSnapshot(latestSnapshot);
					setSnapshots(latestSnapshots);
					if (latestProject) {
						setActiveProject(latestProject);
						activeProjectRef.current = latestProject;
					}
					setDraft(null);
					setSaveStatus('saved');
					setSaveError(null);
					await refreshProjects();
					return true;
				} catch (error) {
					try {
						const nextDraft: DraftRecord = {
							projectId: project.projectId,
							draftId: `draft-${project.projectId}`,
							updatedAt: new Date().toISOString(),
							contentHash,
							state: stateToSave,
						};
						await writeDraft(nextDraft);
						setDraft(nextDraft);
					} catch {
						// Preserve the primary snapshot error if writing the draft also fails.
					}
					setSaveStatus('save-error');
					setSaveError(projectErrorMessage(error));
					return false;
				}
			};
			const queued = saveQueueRef.current.catch(() => false).then(operation);
			saveQueueRef.current = queued.catch(() => false);
			return queued;
		},
		[isReadOnly, refreshProjects],
	);

	useEffect(() => {
		autosaveRef.current?.cancel();
		autosaveRef.current = createAutosaveScheduler(() => {
			void enqueueSave('autosave');
		});
		return () => autosaveRef.current?.cancel();
	}, [enqueueSave]);

	useEffect(() => {
		if (!activeProject || !currentSnapshot || !state.initialized || isReadOnly)
			return;
		if (skipNextStateEffectRef.current) {
			skipNextStateEffectRef.current = false;
			return;
		}
		const stateToCompare = cleanUpStateBeforeSaving(
			stateRef.current.undoableState,
		);
		const currentHash = stateFingerprint(stateToCompare);
		const persistedHash =
			persistedHashRef.current ?? currentSnapshot.contentHash;
		if (currentHash === persistedHash) {
			if (saveStatus !== 'recovery') setSaveStatus('saved');
			return;
		}
		setSaveStatus((previous) => (previous === 'saving' ? previous : 'dirty'));
		if (saveStatus !== 'saving') autosaveRef.current?.notifyDirty();
	}, [
		activeProject,
		currentSnapshot,
		isReadOnly,
		projectCommitRevision,
		saveStatus,
		state.initialized,
	]);

	/** RenderJobs are persisted facts; EditorState only receives their UI projection. */
	useEffect(() => {
		const projectId = activeProject?.projectId;
		if (!projectId) {
			setEditorState((previous) => ({...previous, renderingTasks: []}));
			return;
		}
		let cancelled = false;
		let currentJobs: RenderJob[] = [];
		const syncProjection = (jobs: RenderJob[]) => {
			if (cancelled) return;
			currentJobs = jobs;
			setEditorState((previous) => ({
				...previous,
				renderingTasks: jobs.map((job) => renderJobToRenderingTask(job)),
			}));
		};
		const syncOne = (job: RenderJob) => {
			if (job.projectId !== projectId || cancelled) return;
			const next = currentJobs.some((candidate) => candidate.jobId === job.jobId)
				? currentJobs.map((candidate) =>
						candidate.jobId === job.jobId ? job : candidate,
					)
				: [job, ...currentJobs];
			syncProjection(next);
		};
		const unsubscribe = renderJobStore.subscribe((event) => {
			if (event.type === 'deleted') {
				if (event.projectId !== projectId) return;
				syncProjection(currentJobs.filter((job) => job.jobId !== event.jobId));
				return;
			}
			syncOne(event.job);
		});
		const load = async () => {
			try {
				const jobs = await renderJobStore.list(projectId);
				if (cancelled) return;
				syncProjection(jobs);
				for (const job of jobs) {
					resumeRenderJobPolling(job, syncOne);
				}
			} catch {
				// The project context already exposes IndexedDB errors through save state.
				// A missing task projection must not prevent the editor from opening.
			}
		};
		void load();
		return () => {
			cancelled = true;
			unsubscribe();
			stopProjectRenderPolling(projectId, currentJobs);
		};
	}, [activeProject?.projectId, setEditorState]);

	const saveNow = useCallback(
		async (
			reason: Extract<
				SnapshotReason,
				'manual' | 'autosave' | 'command'
			> = 'manual',
		) => {
			autosaveRef.current?.cancel();
			return enqueueSave(reason);
		},
		[enqueueSave],
	);

	const retrySave = useCallback(() => saveNow('manual'), [saveNow]);

	const reloadAfterSnapshot = useCallback(
		async (nextSnapshot: ProjectSnapshot) => {
			const project = activeProjectRef.current;
			if (!project) return false;
			const records = await refreshActiveRecords(project.projectId);
			if (!records.project) return false;
			await commitLoadedRecords({
				project: records.project,
				snapshot: nextSnapshot,
				nextSnapshots: records.snapshots,
				nextDraft: records.draft,
			});
			return true;
		},
		[commitLoadedRecords, refreshActiveRecords],
	);

	const importState = useCallback(
		async (inputState: UndoableState) => {
			const project = activeProjectRef.current;
			if (!project || !isSchemaSupported(inputState)) return false;
			try {
				const normalized = normalizeUndoableState(inputState);
				const written = await saveSnapshot({
					projectId: project.projectId,
					state: normalized,
					reason: 'import',
				});
				return written ? reloadAfterSnapshot(written) : false;
			} catch (error) {
				setSaveStatus('save-error');
				setSaveError(projectErrorMessage(error));
				return false;
			}
		},
		[reloadAfterSnapshot],
	);

	const restoreSnapshot = useCallback(
		async (snapshotId: string) => {
			const project = activeProjectRef.current;
			const source = snapshots.find(
				(snapshot) => snapshot.snapshotId === snapshotId,
			);
			if (!project || !source) return false;
			try {
				const written = await saveSnapshot({
					projectId: project.projectId,
					state: source.state,
					reason: 'restore',
				});
				return written ? reloadAfterSnapshot(written) : false;
			} catch (error) {
				setSaveStatus('save-error');
				setSaveError(projectErrorMessage(error));
				return false;
			}
		},
		[reloadAfterSnapshot, snapshots],
	);

	const removeSnapshot = useCallback(async (snapshotId: string) => {
		await storeDeleteSnapshot(snapshotId);
		const project = activeProjectRef.current;
		if (project) setSnapshots(await listSnapshots(project.projectId));
	}, []);

	const restoreDraft = useCallback(async () => {
		const project = activeProjectRef.current;
		if (!project || !draft) return false;
		try {
			const written = await saveSnapshot({
				projectId: project.projectId,
				state: draft.state,
				reason: 'restore',
			});
			return written ? reloadAfterSnapshot(written) : false;
		} catch (error) {
			setSaveStatus('save-error');
			setSaveError(projectErrorMessage(error));
			return false;
		}
	}, [draft, reloadAfterSnapshot]);

	const discardDraft = useCallback(async () => {
		const project = activeProjectRef.current;
		if (!project) return;
		await storeDeleteDraft(project.projectId);
		setDraft(null);
		setSaveError(null);
		setSaveStatus('saved');
	}, []);

	const downloadDraft = useCallback(() => {
		if (!draft) return;
		downloadJson(
			`project-draft-${draft.projectId}-${new Date().toISOString().slice(0, 10)}.json`,
			{
				format: 'novelcomic-remotion-draft',
				projectId: draft.projectId,
				draftId: draft.draftId,
				contentHash: draft.contentHash,
				updatedAt: draft.updatedAt,
				state: draft.state,
			},
		);
	}, [draft]);

	const downloadBackup = useCallback(
		(snapshot: ProjectSnapshot | null = currentSnapshotRef.current) => {
			if (!snapshot) return;
			downloadJson(
				`project-${snapshot.projectId}-revision-${snapshot.revision}.json`,
				{
					format: 'novelcomic-remotion-project-backup',
					project: activeProjectRef.current,
					snapshot,
					state: snapshot.state,
				},
			);
		},
		[],
	);

	const downloadMigrationBackup = useCallback(() => {
		if (!migrationFailure) return;
		downloadJson('novelcomic-remotion-legacy-backup.json', {
			format: 'novelcomic-remotion-legacy-backup',
			rawStateJson: migrationFailure.rawStateJson,
			error: migrationFailure.error.message,
		});
	}, [migrationFailure]);

	const createNewProject = useCallback(
		async (name: string) => {
			try {
				const created = await storeCreateProject({name});
				await refreshProjects();
				await activateProject(created.projectId);
				return created;
			} catch (error) {
				setSaveError(projectErrorMessage(error));
				return null;
			}
		},
		[activateProject, refreshProjects],
	);

	const rename = useCallback(
		async (projectId: string, name: string) => {
			const renamed = await storeRenameProject(projectId, name);
			if (activeProjectRef.current?.projectId === projectId)
				setActiveProject(renamed);
			await refreshProjects();
		},
		[refreshProjects],
	);

	const duplicate = useCallback(
		async (projectId: string, name: string) => {
			try {
				const duplicated = await storeDuplicateProject(projectId, name);
				await refreshProjects();
				return duplicated;
			} catch (error) {
				setSaveError(projectErrorMessage(error));
				return null;
			}
		},
		[refreshProjects],
	);

	const archive = useCallback(
		async (projectId: string) => {
			await storeArchiveProject(projectId);
			if (activeProjectRef.current?.projectId === projectId)
				setActiveProject((previous) =>
					previous ? {...previous, archived: true} : previous,
				);
			await refreshProjects();
		},
		[refreshProjects],
	);

	const restore = useCallback(
		async (projectId: string) => {
			await storeRestoreProject(projectId);
			if (activeProjectRef.current?.projectId === projectId)
				setActiveProject((previous) =>
					previous ? {...previous, archived: false} : previous,
				);
			await refreshProjects();
		},
		[refreshProjects],
	);

	const remove = useCallback(
		async (projectId: string) => {
			await storeDeleteProject(projectId);
			await refreshProjects();
			if (activeProjectRef.current?.projectId === projectId) {
				setActiveProject(null);
				setCurrentSnapshot(null);
				setSnapshots([]);
				setDraft(null);
				persistedHashRef.current = null;
				writeProjectIdToUrl(null);
				setEditorState((previous) => ({...previous, initialized: false}));
				setProjectListOpen(true);
				setSaveStatus('idle');
			}
		},
		[refreshProjects, setEditorState],
	);

	const value = useMemo<ProjectContextValue>(
		() => ({
			activeProject,
			currentSnapshot,
			snapshots,
			draft,
			projects,
			isLoading,
			isReadOnly,
			readOnlyReason,
			migrationFailure,
			saveStatus,
			saveError,
			openProject: (projectId) => activateProject(projectId),
			createProject: createNewProject,
			renameProject: rename,
			duplicateProject: duplicate,
			archiveProject: archive,
			restoreProject: restore,
			deleteProject: remove,
			refreshProjects,
			saveNow,
			retrySave,
			importState,
			restoreSnapshot,
			deleteSnapshot: removeSnapshot,
			restoreDraft,
			discardDraft,
			downloadDraft,
			downloadBackup,
			downloadMigrationBackup,
			openProjectList: () => setProjectListOpen(true),
			closeProjectList: () => setProjectListOpen(false),
			projectListOpen,
			openVersionList: () => setVersionListOpen(true),
			closeVersionList: () => setVersionListOpen(false),
			versionListOpen,
			unsupportedSchemaVersion,
		}),
		[
			activeProject,
			archive,
			activateProject,
			createNewProject,
			currentSnapshot,
			discardDraft,
			downloadBackup,
			downloadDraft,
			downloadMigrationBackup,
			draft,
			duplicate,
			importState,
			isLoading,
			isReadOnly,
			migrationFailure,
			projectListOpen,
			projects,
			readOnlyReason,
			refreshProjects,
			remove,
			rename,
			restore,
			restoreDraft,
			restoreSnapshot,
			retrySave,
			saveError,
			saveNow,
			saveStatus,
			snapshots,
			unsupportedSchemaVersion,
			versionListOpen,
			removeSnapshot,
		],
	);

	const showEntryPanel = !isLoading && (!activeProject || isReadOnly);
	return (
		<ProjectContext.Provider value={value}>
			{showEntryPanel ? <ProjectListPanel /> : null}
			{activeProject && !isReadOnly ? children : null}
			{activeProject && !isReadOnly && projectListOpen ? (
				<ProjectListPanel modal />
			) : null}
			{activeProject && !isReadOnly && versionListOpen ? (
				<ProjectListPanel modal initialView="versions" />
			) : null}
			{activeProject && !isReadOnly && saveStatus === 'recovery' ? (
				<RecoveryDialog />
			) : null}
		</ProjectContext.Provider>
	);
};
