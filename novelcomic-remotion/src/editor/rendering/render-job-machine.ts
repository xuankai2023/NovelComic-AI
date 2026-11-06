import {
	isValidRenderOutput,
	RENDER_JOB_MAX_ATTEMPTS,
	type RenderJob,
	type RenderJobError,
	type RenderJobHandle,
	type RenderJobInput,
	type RenderJobOutput,
	type RenderJobStatus,
} from './render-job-types';

export type RenderJobEvent =
	| {type: 'validate'}
	| {type: 'submit'; handle: RenderJobHandle; backend?: RenderJob['backend']}
	| {type: 'start'}
	| {type: 'progress'; progress: number}
	| {type: 'request-cancel'}
	| {type: 'cancel'}
	| {type: 'cancel-unsupported'; error?: RenderJobError}
	| {
			type: 'succeed';
			output: RenderJobOutput;
	  }
	| {
			type: 'fail';
			error: RenderJobError;
	  }
	| {type: 'retry'};

export class RenderJobTransitionError extends Error {
	readonly from: RenderJobStatus;
	readonly event: RenderJobEvent['type'];

	constructor(from: RenderJobStatus, event: RenderJobEvent['type']) {
		super(`Invalid RenderJob transition: ${from} -> ${event}`);
		this.name = 'RenderJobTransitionError';
		this.from = from;
		this.event = event;
	}
}

export class RenderJobOutputError extends Error {
	constructor(message = 'Render output is missing a valid URL or size.') {
		super(message);
		this.name = 'RenderJobOutputError';
	}
}

const activeStatuses = new Set<RenderJobStatus>([
	'queued',
	'validating',
	'submitted',
	'running',
	'cancel-requested',
]);

const terminalStatuses = new Set<RenderJobStatus>([
	'succeeded',
	'failed',
	'canceled',
]);

export const isRenderJobActive = (status: RenderJobStatus) =>
	activeStatuses.has(status);

export const isRenderJobTerminal = (status: RenderJobStatus) =>
	terminalStatuses.has(status);

export const canTransitionRenderJob = (
	from: RenderJobStatus,
	event: RenderJobEvent['type'],
): boolean => {
	if (event === 'validate') return from === 'queued';
	if (event === 'submit') return from === 'validating';
	if (event === 'start') return from === 'submitted';
	if (event === 'progress') {
		return (
			from === 'submitted' || from === 'running' || from === 'cancel-requested'
		);
	}
	if (event === 'request-cancel') {
		return from !== 'cancel-requested' && isRenderJobActive(from);
	}
	if (event === 'cancel')
		return from === 'cancel-requested' || isRenderJobActive(from);
	if (event === 'cancel-unsupported') return from === 'cancel-requested';
	if (event === 'succeed') {
		// A real backend completion wins a cancel request race.
		return (
			from === 'submitted' || from === 'running' || from === 'cancel-requested'
		);
	}
	if (event === 'fail') {
		return (
			from === 'validating' ||
			from === 'submitted' ||
			from === 'running' ||
			from === 'cancel-requested'
		);
	}
	if (event === 'retry') return from === 'failed';
	return false;
};

const timestamp = () => new Date().toISOString();

const withTimestamp = (
	job: RenderJob,
	patch: Partial<RenderJob>,
): RenderJob => ({
	...job,
	...patch,
	updatedAt: timestamp(),
});

const clampProgress = (progress: number) =>
	Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));

export const createRenderJob = (input: RenderJobInput): RenderJob => {
	if (!input.projectId || !input.inputSnapshotId || !input.inputContentHash) {
		throw new Error(
			'RenderJob requires projectId, inputSnapshotId and inputContentHash.',
		);
	}
	const createdAt = input.createdAt ?? timestamp();
	const maxAttempts = Math.max(
		1,
		Math.min(
			RENDER_JOB_MAX_ATTEMPTS,
			Math.floor(input.maxAttempts ?? RENDER_JOB_MAX_ATTEMPTS),
		),
	);
	const id =
		input.jobId ??
		globalThis.crypto?.randomUUID?.() ??
		`render-job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return {
		jobId: id,
		projectId: input.projectId,
		inputSnapshotId: input.inputSnapshotId,
		inputContentHash: input.inputContentHash,
		preflightHash: input.preflightHash,
		inputRevision: input.inputRevision,
		projectName: input.projectName,
		kind: input.kind,
		batchId: input.batchId,
		frameRange: input.frameRange,
		backend: input.backend,
		status: 'queued',
		attempt: 1,
		maxAttempts,
		progress: 0,
		createdAt,
		updatedAt: createdAt,
	};
};

/** Apply one event and reject illegal transitions instead of silently corrupting the job. */
export const transitionRenderJob = (
	job: RenderJob,
	event: RenderJobEvent,
): RenderJob => {
	if (!canTransitionRenderJob(job.status, event.type)) {
		throw new RenderJobTransitionError(job.status, event.type);
	}

	switch (event.type) {
		case 'validate':
			return withTimestamp(job, {status: 'validating', lastError: undefined});
		case 'submit':
			return withTimestamp(job, {
				status: 'submitted',
				backend: event.backend ?? job.backend,
				renderId: event.handle.renderId,
				bucketName: event.handle.bucketName,
				startedAt: job.startedAt ?? timestamp(),
				lastError: undefined,
			});
		case 'start':
			return withTimestamp(job, {
				status: 'running',
				startedAt: job.startedAt ?? timestamp(),
			});
		case 'progress':
			return withTimestamp(job, {
				status: job.status === 'submitted' ? 'running' : job.status,
				progress: clampProgress(event.progress),
			});
		case 'request-cancel':
			return withTimestamp(job, {
				status: 'cancel-requested',
				cancelRequestedFrom: job.status as Exclude<
					RenderJobStatus,
					'cancel-requested'
				>,
			});
		case 'cancel-unsupported': {
			const restoredStatus = job.cancelRequestedFrom;
			if (!restoredStatus) {
				throw new RenderJobTransitionError(job.status, event.type);
			}
			return withTimestamp(job, {
				status: restoredStatus,
				cancelRequestedFrom: undefined,
				lastError: event.error,
			});
		}
		case 'cancel':
			return withTimestamp(job, {
				status: 'canceled',
				finishedAt: timestamp(),
				progress: job.progress,
				cancelRequestedFrom: undefined,
			});
		case 'succeed':
			if (
				!isValidRenderOutput({
					outputFile: event.output.outputFile,
					outputSizeInBytes: event.output.outputSizeInBytes,
					backend: job.backend,
				})
			) {
				throw new RenderJobOutputError();
			}
			return withTimestamp(job, {
				status: 'succeeded',
				progress: 1,
				outputFile: event.output.outputFile,
				outputName: event.output.outputName,
				outputSizeInBytes: event.output.outputSizeInBytes,
				checksum: event.output.checksum,
				finishedAt: timestamp(),
				cancelRequestedFrom: undefined,
				lastError: undefined,
			});
		case 'fail':
			return withTimestamp(job, {
				status: 'failed',
				lastError: event.error,
				finishedAt: timestamp(),
				cancelRequestedFrom: undefined,
			});
		case 'retry':
			if (job.attempt >= job.maxAttempts) {
				throw new Error(`RenderJob retry limit reached (${job.maxAttempts}).`);
			}
			if (!job.lastError?.retryable) {
				throw new Error('This RenderJob failure is not retryable.');
			}
			return withTimestamp(job, {
				status: 'queued',
				attempt: job.attempt + 1,
				progress: 0,
				renderId: undefined,
				bucketName: undefined,
				outputFile: undefined,
				outputName: undefined,
				outputSizeInBytes: undefined,
				checksum: undefined,
				startedAt: undefined,
				finishedAt: undefined,
				lastError: undefined,
			});
	}
};

export const applyRenderJobEvent = transitionRenderJob;
export const isValidRenderJobTransition = canTransitionRenderJob;
