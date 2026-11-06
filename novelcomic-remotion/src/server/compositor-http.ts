import {CompositorServiceError, asCompositorError} from './compositor-errors';

export const jsonBody = async (request: Request): Promise<Record<string, unknown>> => {
	try {
		const body = await request.json();
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Request body must be an object');
		return body as Record<string, unknown>;
	} catch (error) {
		throw new CompositorServiceError({code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid JSON request', status: 400});
	}
};

export const respond = (value: unknown, init?: ResponseInit) => Response.json(value, init);
export const handleCompositorError = (error: unknown) => {
	const failure = asCompositorError(error);
	return respond({error: {code: failure.code, message: failure.message, retryable: failure.retryable, ...(failure.details ? {details: failure.details} : {})}}, {status: failure.status});
};
export const withCompositorErrors = async (handler: () => Promise<Response> | Response) => {
	try { return await handler(); } catch (error) { return handleCompositorError(error); }
};

export const requiredString = (value: unknown, field: string) => {
	if (typeof value !== 'string' || !value.trim()) throw new CompositorServiceError({code: 'INVALID_REQUEST', message: `${field} is required`});
	return value.trim();
};
export const integer = (value: unknown, field: string, min = 0) => {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min) throw new CompositorServiceError({code: 'INVALID_REQUEST', message: `${field} must be an integer >= ${min}`});
	return value;
};
