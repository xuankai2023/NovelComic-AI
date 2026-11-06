import {
	COMIC_ERROR_CODES,
	ComicEditorError,
	domainInvariant,
} from './errors';
import type {LayerPackage} from './types';

export type SegmentationCanvas = {
	width: number;
	height: number;
};

export type LayerSegmentationRequest = {
	projectId: string;
	shotId: string;
	sourceUrl: string;
	canvas: SegmentationCanvas;
	semanticHints?: string[];
	clientRequestId?: string;
};

export type LayerSegmentationTask = {
	jobId: string;
	status: 'queued' | 'running';
	progress?: number;
};

export type LayerSegmentationStatus =
	| LayerSegmentationTask
	| {
			jobId: string;
			status: 'failed';
			error: string;
			retryable: boolean;
	  }
	| {
			jobId: string;
			status: 'done';
			layerPackage: LayerPackage;
	  };

const serviceUnavailable = (message: string): ComicEditorError => {
	return new ComicEditorError({
		code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
		message,
		retryable: true,
		status: 503,
	});
};

const readServiceUrl = (): URL => {
	const raw = process.env.COMIC_SEGMENTATION_SERVICE_URL?.trim();
	if (!raw) {
		throw serviceUnavailable('COMIC_SEGMENTATION_SERVICE_URL is not configured');
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw serviceUnavailable('COMIC_SEGMENTATION_SERVICE_URL is invalid');
	}

	if (url.protocol !== 'https:') {
		throw serviceUnavailable('COMIC_SEGMENTATION_SERVICE_URL must use HTTPS');
	}

	return url;
};

const endpoint = (path: string): string => {
	const base = readServiceUrl();
	const prefix = base.pathname.replace(/\/+$/, '');
	base.pathname = `${prefix}/${path.replace(/^\/+/, '')}`;
	base.search = '';
	base.hash = '';
	return base.href;
};

const headers = (): HeadersInit => {
	const next: Record<string, string> = {'content-type': 'application/json'};
	const token = process.env.COMIC_SEGMENTATION_API_KEY?.trim();
	if (token) {
		next.authorization = `Bearer ${token}`;
	}

	return next;
};

const readJson = async (response: Response): Promise<unknown> => {
	try {
		return await response.json();
	} catch {
		throw serviceUnavailable('Segmentation service returned invalid JSON');
	}
};

const assertOk = async (response: Response): Promise<unknown> => {
	const body = await readJson(response);
	if (!response.ok) {
		const message =
			body && typeof body === 'object' && 'message' in body
				? String((body as {message: unknown}).message)
				: `Segmentation service failed with ${response.status}`;
		throw serviceUnavailable(message);
	}

	return body;
};

const readString = (
	value: unknown,
	field: string,
): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw domainInvariant(`Segmentation response is missing ${field}`);
	}

	return value;
};

const readProgress = (value: unknown): number | undefined => {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw domainInvariant('Segmentation progress must be a finite number');
	}

	return Math.max(0, Math.min(1, value));
};

export const requestLayerSegmentation = async (
	input: LayerSegmentationRequest,
): Promise<LayerSegmentationTask> => {
	const response = await fetch(endpoint('/segmentations'), {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify(input),
	});
	const body = await assertOk(response);
	if (!body || typeof body !== 'object') {
		throw domainInvariant('Segmentation response must be an object');
	}

	const record = body as Record<string, unknown>;
	const status = record.status === 'running' ? 'running' : 'queued';
	const task: LayerSegmentationTask = {
		jobId: readString(record.jobId, 'jobId'),
		status,
	};
	const progress = readProgress(record.progress);
	if (progress !== undefined) {
		task.progress = progress;
	}

	return task;
};

export const getLayerSegmentationStatus = async (
	jobId: string,
	parseLayerPackage: (value: unknown) => LayerPackage,
): Promise<LayerSegmentationStatus> => {
	const response = await fetch(
		endpoint(`/segmentations/${encodeURIComponent(jobId)}`),
		{
			method: 'GET',
			headers: headers(),
		},
	);
	const body = await assertOk(response);
	if (!body || typeof body !== 'object') {
		throw domainInvariant('Segmentation status response must be an object');
	}

	const record = body as Record<string, unknown>;
	const returnedJobId = readString(record.jobId ?? jobId, 'jobId');
	const status = readString(record.status, 'status');
	if (status === 'queued' || status === 'running') {
		const task: LayerSegmentationTask = {
			jobId: returnedJobId,
			status,
		};
		const progress = readProgress(record.progress);
		if (progress !== undefined) {
			task.progress = progress;
		}

		return task;
	}

	if (status === 'failed') {
		return {
			jobId: returnedJobId,
			status,
			error:
				typeof record.error === 'string' && record.error.trim()
					? record.error
					: 'Segmentation failed',
			retryable:
				typeof record.retryable === 'boolean' ? record.retryable : true,
		};
	}

	if (status === 'done') {
		return {
			jobId: returnedJobId,
			status,
			layerPackage: parseLayerPackage(record.layerPackage),
		};
	}

	throw domainInvariant(`Unknown segmentation status: ${status}`);
};

