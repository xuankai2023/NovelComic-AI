import {
	createRenderJob as createStoredRenderJob,
	deleteRenderJob as deleteStoredRenderJob,
	getRenderJob as getStoredRenderJob,
	listRenderJobs as listStoredRenderJobs,
	putRenderJob as putStoredRenderJob,
	updateRenderJob as updateStoredRenderJob,
} from '../project/project-store';
import {createRenderJob as createRenderJobRecord} from './render-job-machine';
import type {
	RenderJob,
	RenderJobInput,
	RenderJobRecordEvent,
} from './render-job-types';

export type RenderJobListener = (event: RenderJobRecordEvent) => void;

const listeners = new Set<RenderJobListener>();

const emit = (event: RenderJobRecordEvent) => {
	for (const listener of listeners) {
		try {
			listener(event);
		} catch {
			// A stale UI subscriber must never fail a persistence operation.
		}
	}
};

export class RenderJobStore {
	async create(input: RenderJobInput): Promise<RenderJob> {
		const job = createRenderJobRecord(input);
		const stored = await createStoredRenderJob(job);
		emit({type: 'created', job: stored});
		return stored;
	}

	async put(job: RenderJob): Promise<RenderJob> {
		const stored = await putStoredRenderJob(job);
		emit({type: 'updated', job: stored});
		return stored;
	}

	async get(jobId: string): Promise<RenderJob | null> {
		return getStoredRenderJob(jobId);
	}

	async list(
		projectId: string,
		options?: {includeTerminal?: boolean},
	): Promise<RenderJob[]> {
		return listStoredRenderJobs(projectId, options);
	}

	async update(
		jobId: string,
		updater: (job: RenderJob) => RenderJob,
	): Promise<RenderJob> {
		const stored = await updateStoredRenderJob(jobId, updater);
		emit({type: 'updated', job: stored});
		return stored;
	}

	async delete(jobId: string, projectId?: string): Promise<void> {
		await deleteStoredRenderJob(jobId);
		emit({type: 'deleted', jobId, projectId});
	}

	subscribe(listener: RenderJobListener): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}
}

export const renderJobStore = new RenderJobStore();

export const subscribeToRenderJobs = (listener: RenderJobListener) =>
	renderJobStore.subscribe(listener);
