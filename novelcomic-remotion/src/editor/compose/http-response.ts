import {ZodError} from 'zod';
import {
	COMIC_ERROR_CODES,
	ComicEditorError,
	type ComicErrorCode,
} from '../comic/errors';

export type ComposeFailure = {
	type: 'error';
	code: ComicErrorCode;
	message: string;
	retryable: boolean;
	shotId?: string;
	itemId?: string;
	assetId?: string;
};

export const composeSuccess = <T extends object>(
	data: T,
): {type: 'success'} & T => {
	return {
		...data,
		type: 'success',
	};
};

export const composeError = (error: ComicEditorError): ComposeFailure => {
	const body: ComposeFailure = {
		type: 'error',
		code: error.code,
		message: error.message,
		retryable: error.retryable,
	};

	if (error.shotId !== undefined) {
		body.shotId = error.shotId;
	}

	if (error.itemId !== undefined) {
		body.itemId = error.itemId;
	}

	if (error.assetId !== undefined) {
		body.assetId = error.assetId;
	}

	return body;
};

const jsonError = (
	code: ComicErrorCode,
	message: string,
	retryable: boolean,
	status: number,
): Response => {
	const body: ComposeFailure = {
		type: 'error',
		code,
		message,
		retryable,
	};
	return Response.json(body, {status});
};

export const errorToResponse = (error: unknown): Response => {
	if (error instanceof ComicEditorError) {
		return Response.json(composeError(error), {status: error.status});
	}

	if (error instanceof ZodError || error instanceof SyntaxError) {
		return jsonError(
			COMIC_ERROR_CODES.INVALID_REQUEST,
			'Invalid request',
			false,
			400,
		);
	}

	return jsonError(COMIC_ERROR_CODES.INTERNAL, 'Internal error', false, 500);
};

export type ComposeCounts = {
	itemCount: number;
	shotCount: number;
	assetCount: number;
};

export type ComposeObservation = ComposeCounts & {
	requestId: string;
	operation: string;
	durationMs: number;
	code?: ComicErrorCode;
};

const recordSize = (value: unknown): number => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return 0;
	}

	return Object.keys(value).length;
};

export const countComposeBody = (body: unknown): ComposeCounts => {
	if (!body || typeof body !== 'object') {
		return {itemCount: 0, shotCount: 0, assetCount: 0};
	}

	const project = (body as {project?: unknown}).project;
	if (!project || typeof project !== 'object') {
		return {itemCount: 0, shotCount: 0, assetCount: 0};
	}

	const record = project as {
		items?: unknown;
		shots?: unknown;
		assets?: unknown;
	};
	return {
		itemCount: recordSize(record.items),
		shotCount: Array.isArray(record.shots) ? record.shots.length : 0,
		assetCount: recordSize(record.assets),
	};
};

export const composeErrorCode = (error: unknown): ComicErrorCode => {
	if (error instanceof ComicEditorError) {
		return error.code;
	}

	if (error instanceof ZodError || error instanceof SyntaxError) {
		return COMIC_ERROR_CODES.INVALID_REQUEST;
	}

	return COMIC_ERROR_CODES.INTERNAL;
};

export const operationFromRequest = (request: Request): string => {
	try {
		const {pathname} = new URL(request.url);
		const marker = '/api/compose/';
		const index = pathname.indexOf(marker);
		const raw =
			index >= 0 ? pathname.slice(index + marker.length) : pathname.slice(1);
		const operation = raw.replace(/\/$/, '');
		return operation || 'compose';
	} catch {
		return 'compose';
	}
};

export const readRequestId = (request: Request): string => {
	const header = request.headers.get('x-request-id')?.trim();
	return header || crypto.randomUUID();
};

export const logComposeObservation = (entry: ComposeObservation): void => {
	const payload: Record<string, string | number> = {
		requestId: entry.requestId,
		operation: entry.operation,
		durationMs: entry.durationMs,
		itemCount: entry.itemCount,
		shotCount: entry.shotCount,
		assetCount: entry.assetCount,
	};
	if (entry.code) {
		payload.code = entry.code;
	}

	// eslint-disable-next-line no-console
	console.info(JSON.stringify(payload));
};

const finishComposeObservation = (
	requestId: string,
	startedAt: number,
	response: Response,
	details: {
		operation: string;
		counts: ComposeCounts;
		code?: ComicErrorCode;
	},
): Response => {
	response.headers.set('x-request-id', requestId);
	logComposeObservation({
		requestId,
		operation: details.operation,
		durationMs: Date.now() - startedAt,
		itemCount: details.counts.itemCount,
		shotCount: details.counts.shotCount,
		assetCount: details.counts.assetCount,
		code: details.code,
	});
	return response;
};

export const runComposeRoute = async (
	request: Request,
	handle: (body: unknown) => Promise<object> | object,
): Promise<Response> => {
	const startedAt = Date.now();
	const requestId = readRequestId(request);
	const operation = operationFromRequest(request);
	let counts: ComposeCounts = {itemCount: 0, shotCount: 0, assetCount: 0};

	try {
		const body: unknown = await request.json();
		counts = countComposeBody(body);
		const data = await handle(body);
		return finishComposeObservation(
			requestId,
			startedAt,
			Response.json(composeSuccess(data)),
			{operation, counts},
		);
	} catch (error) {
		return finishComposeObservation(
			requestId,
			startedAt,
			errorToResponse(error),
			{
				operation,
				counts,
				code: composeErrorCode(error),
			},
		);
	}
};
