import type {ProjectSnapshot} from '../project/types';

export const RENDER_JOB_MAX_ATTEMPTS = 3 as const;

export type RenderJobStatus =
	| 'queued'
	| 'validating'
	| 'submitted'
	| 'running'
	| 'cancel-requested'
	| 'succeeded'
	| 'failed'
	| 'canceled';

export type RenderJobKind =
	| 'preview-frame'
	| 'full-video'
	| 'batch'
	| 'merge'
	| 'delivery';

export type RenderJobBackend = 'local' | 'lambda';

export type RenderJobError = {
	code: string;
	message: string;
	retryable: boolean;
};

export type RenderJobOutput = {
	outputFile: string;
	outputName?: string;
	outputSizeInBytes: number;
	checksum?: string;
};

export type RenderJob = {
	jobId: string;
	projectId: string;
	inputSnapshotId: string;
	inputContentHash: string;
	/** Hash of the validation and capabilities result that admitted this job. */
	preflightHash?: string;
	/** The revision is denormalized for the task panel; the snapshot remains authoritative. */
	inputRevision?: number;
	projectName?: string;
	kind: RenderJobKind;
	batchId?: string;
	frameRange?: [startFrame: number, endFrameInclusive: number];
	backend: RenderJobBackend;
	status: RenderJobStatus;
	attempt: number;
	maxAttempts: number;
	progress: number;
	renderId?: string;
	bucketName?: string;
	outputFile?: string;
	outputName?: string;
	outputSizeInBytes?: number;
	checksum?: string;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	lastError?: RenderJobError;
	/** The status before cancel was requested; used to restore UI on CANCEL_UNSUPPORTED. */
	cancelRequestedFrom?: Exclude<RenderJobStatus, 'cancel-requested'>;
};

export type RenderJobInput = {
	projectId: string;
	inputSnapshotId: string;
	inputContentHash: string;
	preflightHash?: string;
	inputRevision?: number;
	projectName?: string;
	kind: RenderJobKind;
	batchId?: string;
	frameRange?: [startFrame: number, endFrameInclusive: number];
	backend: RenderJobBackend;
	maxAttempts?: number;
	jobId?: string;
	createdAt?: string;
};

export type RenderJobHandle = {
	renderId: string;
	bucketName: string;
};

export type RenderJobProgress = {
	type: 'in-progress';
	overallProgress: number;
};

export type RenderJobTerminalResult =
	| ({type: 'done'} & RenderJobOutput)
	| {type: 'error'; error: string; code?: string; retryable?: boolean}
	| {type: 'canceled'};

export type RenderJobRecordEvent =
	| {type: 'created'; job: RenderJob}
	| {type: 'updated'; job: RenderJob}
	| {type: 'deleted'; jobId: string; projectId?: string};

/**
 * A render output must be traceable to an actual URL or a local file result.
 * Lambda is deliberately stricter because a signed/non-HTTPS URL is not a
 * stable delivery reference.
 */
export const isValidRenderOutput = ({
	outputFile,
	outputSizeInBytes,
	backend,
}: {
	outputFile: string;
	outputSizeInBytes: number;
	backend: RenderJobBackend;
}): boolean => {
	if (
		!outputFile ||
		!Number.isFinite(outputSizeInBytes) ||
		outputSizeInBytes < 0
	) {
		return false;
	}

	try {
		const parsed = new URL(outputFile);
		if (parsed.protocol === 'https:') return true;
		return backend === 'local' && parsed.protocol === 'file:';
	} catch {
		// A local renderer may return an absolute file path. Lambda may not.
		return backend === 'local' && outputFile.startsWith('/');
	}
};

export const renderJobFromSnapshot = ({
	snapshot,
	...input
}: Omit<
	RenderJobInput,
	'inputSnapshotId' | 'inputContentHash' | 'inputRevision'
> & {
	snapshot: ProjectSnapshot;
}): RenderJobInput => ({
	...input,
	inputSnapshotId: snapshot.snapshotId,
	inputContentHash: snapshot.contentHash,
	inputRevision: snapshot.revision,
});
