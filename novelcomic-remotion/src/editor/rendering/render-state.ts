import {taskIndicatorRef} from '../action-row/tasks-indicator/tasks-indicator';
import type {EditorStarterAsset} from '../assets/assets';
import type {Shot} from '../comic/types';
import type {AdvancedProjectState} from '../composition/types';
import type {SetState} from '../context-provider';
import type {EditorStarterItem} from '../items/item-type';
import type {PropertyGraphV1} from '../property/types';
import {addRenderingTask} from '../state/actions/set-render-state';
import type {TrackType} from '../state/types';
import {getEditorExportFileName} from '../utils/export-file-name';
import type {CodecOption} from './codec-selector';
import {
	clientRenderBackend,
	createAndSubmitRenderJob,
} from './render-job-runtime';
import type {RenderJob, RenderJobInput} from './render-job-types';
import {createRenderPollingController} from './render-polling-controller';
import type {RenderVideoPayload, RenderVideoResponse} from './types';

export type RenderingTaskState =
	| {type: 'render-initiated'}
	| {
			type: 'done';
			outputFile: string;
			outputSizeInBytes: number;
			doneAt: number;
			checksum?: string;
		}
	| {type: 'in-progress'; overallProgress: number}
	| {type: 'cancel-requested'; overallProgress: number}
	| {type: 'canceled'; canceledAt: number}
	| {type: 'error'; error: string; retryable?: boolean};

export type RenderingTask = {
	id: string;
	outputName: string;
	status: RenderingTaskState;
	codec: CodecOption;
	durationInSeconds: number;
	startedAt: number;
	type: 'rendering';
	/** The persisted job is the source of truth; this is a UI projection. */
	renderJob?: RenderJob;
};

export const renderJobToRenderingTask = (
	job: RenderJob,
	codec: CodecOption = 'h264',
): RenderingTask => {
	const startedAt = job.startedAt ? Date.parse(job.startedAt) : Date.parse(job.createdAt);
	let status: RenderingTaskState;
	switch (job.status) {
		case 'queued':
		case 'validating':
		case 'submitted':
			status = {type: 'render-initiated'};
			break;
		case 'running':
			status = {type: 'in-progress', overallProgress: job.progress};
			break;
		case 'cancel-requested':
			status = {type: 'cancel-requested', overallProgress: job.progress};
			break;
		case 'succeeded':
			status = {
				type: 'done',
				outputFile: job.outputFile ?? '',
				outputSizeInBytes: job.outputSizeInBytes ?? 0,
				doneAt: job.finishedAt ? Date.parse(job.finishedAt) : Date.now(),
				checksum: job.checksum,
			};
			break;
		case 'canceled':
			status = {
				type: 'canceled',
				canceledAt: job.finishedAt ? Date.parse(job.finishedAt) : Date.now(),
			};
			break;
		case 'failed':
			status = {
				type: 'error',
				error: job.lastError?.message ?? 'Render failed.',
				retryable: job.lastError?.retryable,
			};
			break;
	}
	return {
		id: job.jobId,
		outputName: job.outputName ?? getEditorExportFileName(codec),
		status,
		codec,
		durationInSeconds: 0,
		startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
		type: 'rendering',
		renderJob: job,
	};
};

const upsertLegacyProjection = (setState: SetState, task: RenderingTask) => {
	setState({
		commitToUndoStack: false,
		update: (previous) => {
			const index = previous.renderingTasks.findIndex((item) => item.id === task.id);
			if (index < 0) return addRenderingTask({state: previous, task});
			const renderingTasks = [...previous.renderingTasks];
			renderingTasks[index] = task;
			return {...previous, renderingTasks};
		},
	});
};

const renderPayload = ({
	compositionHeight,
	compositionWidth,
	fps,
	tracks,
	assets,
	items,
	codec,
	shots,
	advanced,
	propertyGraph,
	frameRange,
}: {
	compositionHeight: number;
	compositionWidth: number;
	fps: number;
	tracks: TrackType[];
	assets: Record<string, EditorStarterAsset>;
	items: Record<string, EditorStarterItem>;
	codec: CodecOption;
	shots: Shot[];
	advanced?: AdvancedProjectState;
	propertyGraph?: PropertyGraphV1;
	frameRange?: RenderVideoPayload['frameRange'];
}): RenderVideoPayload => ({
	compositionHeight,
	compositionWidth,
	fps,
	tracks,
	assets,
	items,
	codec,
	shots,
	advanced,
	propertyGraph,
	...(frameRange ? {frameRange} : {}),
});

const triggerLegacyRender = async ({
	payload,
	setState,
	codec,
	durationInSeconds,
}: {
	payload: RenderVideoPayload;
	setState: SetState;
	codec: CodecOption;
	durationInSeconds: number;
}) => {
	const taskId = `legacy-render-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const task: RenderingTask = {
		id: taskId,
		status: {type: 'render-initiated'},
		codec,
		outputName: getEditorExportFileName(codec),
		durationInSeconds,
		startedAt: Date.now(),
		type: 'rendering',
	};
	upsertLegacyProjection(setState, task);
	taskIndicatorRef.current?.open();
	try {
		const response = await fetch('/api/render', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(payload),
		});
		const json = (await response.json()) as RenderVideoResponse;
		if (!response.ok || json.type === 'error') throw new Error(json.type === 'error' ? json.error : 'Render failed');
		const controller = createRenderPollingController({
			bucketName: json.bucketName,
			renderId: json.renderId,
			onProgress: (progress) => {
				if (progress.type === 'in-progress') {
					upsertLegacyProjection(setState, {
						...task,
						status: {type: 'in-progress', overallProgress: progress.overallProgress},
					});
				} else if (progress.type === 'done') {
					upsertLegacyProjection(setState, {
						...task,
						status: {
							type: 'done',
							outputFile: progress.outputFile,
							outputSizeInBytes: progress.outputSizeInBytes,
							doneAt: Date.now(),
							checksum: progress.checksum,
						},
					});
				} else if (progress.type === 'canceled') {
					upsertLegacyProjection(setState, {...task, status: {type: 'canceled', canceledAt: Date.now()}});
				} else {
					upsertLegacyProjection(setState, {...task, status: {type: 'error', error: progress.error}});
				}
			},
			onNetworkFailure: (error, failures) => {
				if (failures >= 3) {
					upsertLegacyProjection(setState, {
						...task,
						status: {type: 'error', error: error instanceof Error ? error.message : 'Progress unavailable', retryable: true},
					});
				}
			},
		});
		controller.start();
	} catch (error) {
		upsertLegacyProjection(setState, {
			...task,
			status: {type: 'error', error: error instanceof Error ? error.message : 'Render failed'},
		});
	}
};

export const triggerLambdaRender = async ({
	compositionHeight,
	compositionWidth,
	compositionDurationInSeconds,
	fps,
	tracks,
	setState,
	assets,
	items,
	codec,
	shots,
	advanced,
	propertyGraph,
	projectId,
	inputSnapshotId,
	inputContentHash,
	preflightHash,
	warningsConfirmed,
	inputRevision,
	projectName,
	kind = 'full-video',
	batchId,
	frameRange,
}: {
	compositionHeight: number;
	compositionWidth: number;
	compositionDurationInSeconds: number;
	fps: number;
	tracks: TrackType[];
	setState: SetState;
	assets: Record<string, EditorStarterAsset>;
	items: Record<string, EditorStarterItem>;
	codec: CodecOption;
	shots: Shot[];
	advanced?: AdvancedProjectState;
	propertyGraph?: PropertyGraphV1;
	projectId?: string;
	inputSnapshotId?: string;
	inputContentHash?: string;
	preflightHash?: string;
	warningsConfirmed?: boolean;
	inputRevision?: number;
	projectName?: string;
	kind?: RenderJobInput['kind'];
	batchId?: string;
	frameRange?: RenderVideoPayload['frameRange'];
}) => {
	const payload = renderPayload({
		compositionHeight,
		compositionWidth,
		fps,
		tracks,
		assets,
		items,
		codec,
		shots,
		advanced,
		propertyGraph,
		frameRange,
	});
	if (!projectId || !inputSnapshotId || !inputContentHash || !preflightHash) {
		await triggerLegacyRender({payload, setState, codec, durationInSeconds: compositionDurationInSeconds});
		return;
	}
	payload.projectId = projectId;
	payload.inputSnapshotId = inputSnapshotId;
	payload.inputContentHash = inputContentHash;
	payload.preflightHash = preflightHash;
	payload.warningsConfirmed = warningsConfirmed ?? false;

	const input: RenderJobInput = {
		projectId,
		inputSnapshotId,
		inputContentHash,
		preflightHash,
		inputRevision,
		projectName,
		kind,
		backend: clientRenderBackend(),
		batchId,
		frameRange,
	};
	await createAndSubmitRenderJob({
		input,
		payload,
		onUpdate: (next) => {
			const projection = renderJobToRenderingTask(next, codec);
			projection.durationInSeconds = compositionDurationInSeconds;
			upsertLegacyProjection(setState, projection);
		},
	});
	taskIndicatorRef.current?.open();
};
