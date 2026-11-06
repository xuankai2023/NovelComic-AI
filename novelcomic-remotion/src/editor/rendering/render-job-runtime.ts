import {getSnapshot} from '../project/project-store';
import type {ProjectSnapshot} from '../project/types';
import type {RenderJobEvent} from './render-job-machine';
import {RenderJobOutputError, transitionRenderJob} from './render-job-machine';
import {renderJobStore} from './render-job-store';
import type {
	RenderJob,
	RenderJobError,
	RenderJobInput,
} from './render-job-types';
import {
	createRenderPollingController,
	type RenderPollingController,
} from './render-polling-controller';
import type {
	CancelRenderResponse,
	RenderVideoPayload,
	RenderVideoResponse,
} from './types';

const controllers = new Map<string, RenderPollingController>();

const updateJob = async (
	jobId: string,
	event: RenderJobEvent,
): Promise<RenderJob | null> => {
	try {
		return await renderJobStore.update(jobId, (job) =>
			transitionRenderJob(job, event),
		);
	} catch (error) {
		const current = await renderJobStore.get(jobId);
		if (
			current &&
			['succeeded', 'failed', 'canceled'].includes(current.status) &&
			event.type !== 'retry'
		) {
			return current;
		}
		throw error;
	}
};

const outputError = (error: unknown): RenderJobError => ({
	code:
		error instanceof RenderJobOutputError ? 'INVALID_OUTPUT' : 'RENDER_FAILED',
	message: error instanceof Error ? error.message : 'Render failed.',
	retryable: error instanceof RenderJobOutputError ? false : true,
});

const progressError = (error: unknown, failures: number): RenderJobError => ({
	code: failures >= 3 ? 'PROGRESS_UNAVAILABLE' : 'PROGRESS_REQUEST_FAILED',
	message:
		error instanceof Error ? error.message : 'Render progress unavailable.',
	retryable: true,
});

const notify = (
	listener: ((job: RenderJob) => void) | undefined,
	job: RenderJob | null,
) => {
	if (job) listener?.(job);
};

export const snapshotToRenderPayload = (
	snapshot: ProjectSnapshot,
	frameRange?: RenderVideoPayload['frameRange'],
): RenderVideoPayload => ({
	compositionHeight: snapshot.state.compositionHeight,
	compositionWidth: snapshot.state.compositionWidth,
	fps: snapshot.state.fps,
	tracks: snapshot.state.tracks,
	items: snapshot.state.items,
	assets: snapshot.state.assets,
	codec: 'h264',
	shots: snapshot.state.shots ?? [],
	advanced: snapshot.state.advanced,
	propertyGraph: snapshot.state.propertyGraph,
	...(frameRange ? {frameRange} : {}),
});

export const clientRenderBackend = (): RenderJob['backend'] => {
	const value =
		typeof process !== 'undefined'
			? (process.env.NEXT_PUBLIC_REMOTION_RENDER_BACKEND ??
				process.env.REMOTION_RENDER_BACKEND)
			: undefined;
	return value === 'local' ? 'local' : 'lambda';
};

const responseJson = async (
	response: Response,
): Promise<RenderVideoResponse> => {
	const json = (await response.json()) as RenderVideoResponse;
	if (!response.ok) {
		throw new Error(
			json.type === 'error'
				? json.error
				: `Render submission failed with status ${response.status}.`,
		);
	}
	return json;
};

const startPolling = (
	job: RenderJob,
	onUpdate?: (job: RenderJob) => void,
): RenderPollingController => {
	const existing = controllers.get(job.jobId);
	if (existing) return existing;
	if (!job.renderId || !job.bucketName) {
		throw new Error('Cannot poll a RenderJob without a backend handle.');
	}

	const controller = createRenderPollingController({
		bucketName: job.bucketName,
		renderId: job.renderId,
		startedAt: job.startedAt ? Date.parse(job.startedAt) : undefined,
		onProgress: async (response) => {
			if (response.type === 'in-progress') {
				notify(
					onUpdate,
					await updateJob(job.jobId, {
						type: 'progress',
						progress: response.overallProgress,
					}),
				);
				return;
			}
			if (response.type === 'canceled') {
				notify(onUpdate, await updateJob(job.jobId, {type: 'cancel'}));
				return;
			}
			if (response.type === 'error') {
				notify(
					onUpdate,
					await updateJob(job.jobId, {
						type: 'fail',
						error: {
							code: response.code ?? 'RENDER_FAILED',
							message: response.error,
							retryable: response.retryable ?? false,
						},
					}),
				);
				return;
			}
			try {
				notify(
					onUpdate,
					await updateJob(job.jobId, {
						type: 'succeed',
						output: {
							outputFile: response.outputFile,
							outputName: response.outputName,
							outputSizeInBytes: response.outputSizeInBytes,
							checksum: response.checksum,
						},
					}),
				);
			} catch (error) {
				notify(
					onUpdate,
					await updateJob(job.jobId, {type: 'fail', error: outputError(error)}),
				);
			}
		},
		onNetworkFailure: async (error, failures) => {
			if (failures >= 3) {
				notify(
					onUpdate,
					await updateJob(job.jobId, {
						type: 'fail',
						error: progressError(error, failures),
					}),
				);
			}
		},
	});
	controllers.set(job.jobId, controller);
	controller.start();
	void controller.signal.addEventListener('abort', () => {
		if (controllers.get(job.jobId) === controller)
			controllers.delete(job.jobId);
	});
	return controller;
};

export const submitRenderJob = async ({
	job,
	payload,
	onUpdate,
}: {
	job: RenderJob;
	payload: RenderVideoPayload;
	onUpdate?: (job: RenderJob) => void;
}): Promise<RenderJob | null> => {
	let current = await updateJob(job.jobId, {type: 'validate'});
	notify(onUpdate, current);
	if (!current) return null;
	try {
		const response = await responseJson(
			await fetch('/api/render', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify(payload),
			}),
		);
		if (response.type === 'error') throw new Error(response.error);
		const afterSubmission = await renderJobStore.get(job.jobId);
		if (afterSubmission?.status === 'canceled') {
			// A cancel click can arrive while validation/submission is in flight.
			// The backend handle is now known, so cancel the real render instead of
			// leaving a canceled UI task with an orphaned renderer.
			await fetch('/api/render/cancel', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({
					bucketName: response.bucketName,
					renderId: response.renderId,
				}),
			}).catch(() => undefined);
			return afterSubmission;
		}
		current = await updateJob(job.jobId, {
			type: 'submit',
			handle: {renderId: response.renderId, bucketName: response.bucketName},
			backend: response.backend,
		});
		notify(onUpdate, current);
		if (current) startPolling(current, onUpdate);
		return current;
	} catch (error) {
		current = await updateJob(job.jobId, {
			type: 'fail',
			error: outputError(error),
		});
		notify(onUpdate, current);
		return current;
	}
};

export const resumeRenderJobPolling = (
	job: RenderJob,
	onUpdate?: (job: RenderJob) => void,
): RenderPollingController | null => {
	if (
		!['submitted', 'running', 'cancel-requested'].includes(job.status) ||
		!job.renderId ||
		!job.bucketName
	) {
		return null;
	}
	return startPolling(job, onUpdate);
};

export const stopRenderJobPolling = (jobId: string) => {
	controllers.get(jobId)?.stop();
	controllers.delete(jobId);
};

export const stopProjectRenderPolling = (
	projectId: string,
	jobs: RenderJob[],
) => {
	for (const job of jobs) {
		if (job.projectId === projectId) stopRenderJobPolling(job.jobId);
	}
};

export const cancelRenderJob = async (
	job: RenderJob,
	onUpdate?: (job: RenderJob) => void,
): Promise<RenderJob | null> => {
	let current = await renderJobStore.get(job.jobId);
	if (!current || ['succeeded', 'failed', 'canceled'].includes(current.status))
		return current;
	current = await updateJob(job.jobId, {type: 'request-cancel'});
	notify(onUpdate, current);
	if (!current) return null;
	if (!current.renderId || !current.bucketName) {
		stopRenderJobPolling(current.jobId);
		current = await updateJob(current.jobId, {type: 'cancel'});
		notify(onUpdate, current);
		return current;
	}

	try {
		const response = (await (
			await fetch('/api/render/cancel', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({
					bucketName: current.bucketName,
					renderId: current.renderId,
				}),
			})
		).json()) as CancelRenderResponse;
		if (response.type === 'unsupported' || response.type === 'error') {
			current = await updateJob(current.jobId, {
				type: 'cancel-unsupported',
				error: {
					code:
						response.type === 'unsupported'
							? response.code
							: (response.code ?? 'CANCEL_FAILED'),
					message:
						response.type === 'unsupported'
							? response.message
							: response.message,
					retryable: response.type === 'error' ? response.retryable : false,
				},
			});
			notify(onUpdate, current);
			return current;
		}
		stopRenderJobPolling(current.jobId);
		if (response.type === 'done') {
			current = await updateJob(current.jobId, {
				type: 'succeed',
				output: {
					outputFile: response.outputFile,
					outputName: response.outputName,
					outputSizeInBytes: response.outputSizeInBytes,
					checksum: response.checksum,
				},
			});
		} else {
			current = await updateJob(current.jobId, {type: 'cancel'});
		}
		notify(onUpdate, current);
		return current;
	} catch (error) {
		const cancelJobId = current?.jobId;
		if (!cancelJobId) return current;
		current = await updateJob(cancelJobId, {
			type: 'cancel-unsupported',
			error: {
				code: 'CANCEL_REQUEST_FAILED',
				message:
					error instanceof Error ? error.message : 'Cancel request failed.',
				retryable: true,
			},
		});
		notify(onUpdate, current);
		return current;
	}
};

export const retryRenderJob = async (
	job: RenderJob,
	onUpdate?: (job: RenderJob) => void,
): Promise<RenderJob | null> => {
	const current = await renderJobStore.get(job.jobId);
	if (
		!current ||
		current.status !== 'failed' ||
		current.lastError?.retryable !== true ||
		current.attempt >= current.maxAttempts
	) {
		return current;
	}
	const snapshot = await getSnapshot(current.inputSnapshotId);
	if (!snapshot || snapshot.projectId !== current.projectId) {
		const failed = await updateJob(current.jobId, {
			type: 'fail',
			error: {
				code: 'INPUT_SNAPSHOT_NOT_FOUND',
				message: 'The input snapshot for this render is no longer available.',
				retryable: false,
			},
		});
		notify(onUpdate, failed);
		return failed;
	}
	const queued = await updateJob(current.jobId, {type: 'retry'});
	notify(onUpdate, queued);
	if (!queued) return null;
	return submitRenderJob({
		job: queued,
		payload: snapshotToRenderPayload(snapshot, queued.frameRange),
		onUpdate,
	});
};

export const createAndSubmitRenderJob = async ({
	input,
	payload,
	onUpdate,
}: {
	input: RenderJobInput;
	payload: RenderVideoPayload;
	onUpdate?: (job: RenderJob) => void;
}): Promise<RenderJob> => {
	const job = await renderJobStore.create(input);
	notify(onUpdate, job);
	await submitRenderJob({job, payload, onUpdate});
	return (await renderJobStore.get(job.jobId)) ?? job;
};

/** Persist an already-submitted batch handle without submitting it a second time. */
export const attachSubmittedRenderJob = async ({
	input,
	handle,
	backend,
	onUpdate,
}: {
	input: RenderJobInput;
	handle: {renderId: string; bucketName: string};
	backend?: RenderJob['backend'];
	onUpdate?: (job: RenderJob) => void;
}): Promise<RenderJob> => {
	const created = await renderJobStore.create(input);
	notify(onUpdate, created);
	const validating = await updateJob(created.jobId, {type: 'validate'});
	notify(onUpdate, validating);
	const submitted = await updateJob(created.jobId, {
		type: 'submit',
		handle,
		backend,
	});
	notify(onUpdate, submitted);
	if (!submitted) return created;
	startPolling(submitted, onUpdate);
	return submitted;
};

export const waitForRenderJobTerminal = async (
	jobId: string,
	options: {timeoutMs?: number} = {},
): Promise<RenderJob | null> => {
	const existing = await renderJobStore.get(jobId);
	if (
		!existing ||
		['succeeded', 'failed', 'canceled'].includes(existing.status)
	) {
		return existing;
	}
	return new Promise((resolve) => {
		let settled = false;
		const timeout = setTimeout(
			() => {
				if (settled) return;
				settled = true;
				unsubscribe();
				void renderJobStore.get(jobId).then(resolve);
			},
			options.timeoutMs ?? 15 * 60 * 1000,
		);
		const unsubscribe = renderJobStore.subscribe((event) => {
			if (settled || event.type === 'deleted' || event.job.jobId !== jobId)
				return;
			if (!['succeeded', 'failed', 'canceled'].includes(event.job.status))
				return;
			settled = true;
			clearTimeout(timeout);
			unsubscribe();
			resolve(event.job);
		});
	});
};

export const getRenderJobPollingController = (jobId: string) =>
	controllers.get(jobId);
