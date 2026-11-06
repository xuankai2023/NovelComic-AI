import {makeCancelSignal} from '@remotion/renderer';
import type {CancelSignal} from '@remotion/renderer';
import {randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {renderMediaLocal} from './render-media-local';
import type {CancelRenderResponse, GetProgressResponse, RenderVideoPayload} from './types';

export const LOCAL_RENDER_BUCKET = 'local';

const JOB_DIRECTORY = path.join(os.tmpdir(), 'novelcomic-local-renders');

type LocalRenderJob =
	| {
			type: 'in-progress';
			overallProgress: number;
	  }
	| {
			type: 'done';
			overallProgress: 1;
			outputFile: string;
			outputSizeInBytes: number;
			outputName: string;
			checksum?: string;
	  }
	| {
			type: 'error';
			overallProgress: 0;
			error: string;
	  }
	| {
			type: 'canceled';
			overallProgress: number;
	  };

type JobStore = Map<string, LocalRenderJob>;

const jobStore = (): JobStore => {
	const holder = globalThis as typeof globalThis & {
		__novelcomicLocalRenderJobs?: JobStore;
	};
	if (!holder.__novelcomicLocalRenderJobs) {
		holder.__novelcomicLocalRenderJobs = new Map();
	}
	return holder.__novelcomicLocalRenderJobs;
};

type LocalRenderControl = ReturnType<typeof makeCancelSignal>;

const controlStore = (): Map<string, LocalRenderControl> => {
	const holder = globalThis as typeof globalThis & {
		__novelcomicLocalRenderControls?: Map<string, LocalRenderControl>;
	};
	if (!holder.__novelcomicLocalRenderControls) {
		holder.__novelcomicLocalRenderControls = new Map();
	}
	return holder.__novelcomicLocalRenderControls;
};

const jobs = jobStore();
const controls = controlStore();

const safeRenderId = (renderId: string): string | null => {
	if (!/^[A-Za-z0-9-]{1,80}$/.test(renderId)) return null;
	return renderId;
};

const jobPath = (renderId: string): string | null => {
	const safe = safeRenderId(renderId);
	return safe ? path.join(JOB_DIRECTORY, `${safe}.json`) : null;
};

const processAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const isCanceledError = (error: unknown): boolean =>
	error instanceof Error &&
	(error.name.toLowerCase().includes('cancel') ||
		error.message.toLowerCase().includes('cancel'));

const writeJob = (renderId: string, job: LocalRenderJob): void => {
	jobs.set(renderId, job);
	const file = jobPath(renderId);
	if (!file) return;
	mkdirSync(JOB_DIRECTORY, {recursive: true});
	writeFileSync(file, JSON.stringify({pid: process.pid, job}));
};

const readJob = (renderId: string): LocalRenderJob | undefined => {
	const current = jobs.get(renderId);
	if (current) return current;
	const file = jobPath(renderId);
	if (!file) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
			pid?: number;
			job?: LocalRenderJob;
		};
		if (
			typeof parsed.pid !== 'number' ||
			!processAlive(parsed.pid) ||
			!parsed.job ||
			typeof parsed.job !== 'object' ||
			!('type' in parsed.job)
		) {
			return undefined;
		}
		if (parsed.pid === process.pid) jobs.set(renderId, parsed.job);
		return parsed.job;
	} catch {
		return undefined;
	}
};

const finishLocalRender = async (
	renderId: string,
	payload: RenderVideoPayload,
	cancelSignal: ReturnType<typeof makeCancelSignal>['cancelSignal'],
): Promise<void> => {
	try {
		const output = await renderMediaLocal({
			renderId,
			payload,
			cancelSignal,
			onProgress: (progress) => {
				const current = readJob(renderId);
				if (!current || current.type !== 'in-progress') return;
				writeJob(renderId, {type: 'in-progress', overallProgress: progress});
			},
		});
		const current = readJob(renderId);
		if (current?.type === 'canceled') return;
		writeJob(renderId, {
			type: 'done',
			overallProgress: 1,
			outputFile: output.outputFile,
			outputSizeInBytes: output.outputSizeInBytes,
			outputName: output.outputName,
			checksum: output.checksum,
		});
	} catch (error) {
		const current = readJob(renderId);
		if (current?.type === 'canceled' || isCanceledError(error)) {
			if (current?.type !== 'canceled') {
				writeJob(renderId, {type: 'canceled', overallProgress: 0});
			}
			return;
		}
		writeJob(renderId, {
			type: 'error',
			overallProgress: 0,
			error: error instanceof Error ? error.message : 'Local render failed',
		});
	} finally {
		controls.delete(renderId);
	}
};

export const beginLocalRender = (
	payload: RenderVideoPayload,
	options: {cancelSignal?: CancelSignal} = {},
): {renderId: string; bucketName: typeof LOCAL_RENDER_BUCKET} => {
	const renderId = randomUUID();
	const control = makeCancelSignal();
	controls.set(renderId, control);
	options.cancelSignal?.(control.cancel);
	writeJob(renderId, {type: 'in-progress', overallProgress: 0});
	void finishLocalRender(renderId, payload, control.cancelSignal);
	return {renderId, bucketName: LOCAL_RENDER_BUCKET};
};

export const cancelLocalRender = async (
	renderId: string,
): Promise<CancelRenderResponse> => {
	const job = readJob(renderId);
	if (!job) {
		return {
			type: 'error',
			code: 'RENDER_NOT_FOUND',
			message: 'local render was not found',
			retryable: false,
		};
	}
	if (job.type === 'done') {
		return {
			type: 'done',
			outputFile: job.outputFile,
			outputSizeInBytes: job.outputSizeInBytes,
			outputName: job.outputName,
			checksum: job.checksum,
		};
	}
	if (job.type === 'error') {
		return {
			type: 'error',
			code: 'RENDER_FAILED',
			message: job.error,
			retryable: false,
		};
	}
	if (job.type === 'canceled') return {type: 'canceled'};

	const control = controls.get(renderId);
	if (!control) {
		const latest = readJob(renderId);
		if (latest?.type === 'done') {
			return {
				type: 'done',
				outputFile: latest.outputFile,
				outputSizeInBytes: latest.outputSizeInBytes,
				outputName: latest.outputName,
				checksum: latest.checksum,
			};
		}
		if (latest?.type === 'error') {
			return {
				type: 'error',
				code: 'RENDER_FAILED',
				message: latest.error,
				retryable: false,
			};
		}
		if (latest?.type === 'canceled') return {type: 'canceled'};
		return {
			type: 'unsupported',
			code: 'CANCEL_UNSUPPORTED',
			message: 'The local renderer is no longer attached to this process.',
		};
	}
	control.cancel();
	writeJob(renderId, {type: 'canceled', overallProgress: job.overallProgress});
	return {type: 'canceled'};
};

export const localProgressResponse = (
	renderId: string,
): GetProgressResponse => {
	const job = readJob(renderId);
	if (!job) return {type: 'error', error: 'local render was not found'};
	if (job.type === 'done') {
		return {
			type: 'done',
			outputFile: job.outputFile,
			outputSizeInBytes: job.outputSizeInBytes,
			outputName: job.outputName,
			checksum: job.checksum,
		};
	}
	if (job.type === 'error') return {type: 'error', error: job.error};
	if (job.type === 'canceled') return {type: 'canceled'};
	return {type: 'in-progress', overallProgress: job.overallProgress};
};
