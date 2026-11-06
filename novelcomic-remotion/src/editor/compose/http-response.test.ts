import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {COMIC_ERROR_CODES, ComicEditorError} from '../comic/errors';
import {errorToResponse, runComposeRoute} from './http-response';

const readError = async (response: Response) => {
	expect(response.headers.get('content-type')).toContain('application/json');
	return response.json() as Promise<Record<string, unknown>>;
};

describe('errorToResponse', () => {
	it('returns a stable 400 body for schema errors', async () => {
		const leak = 'zod-issue-leak-token';
		let caught: unknown;
		try {
			z.object({token: z.string()}).parse({token: 1, note: leak});
		} catch (error) {
			caught = error;
		}

		const response = errorToResponse(caught);
		const body = await readError(response);

		expect(response.status).toBe(400);
		expect(body).toEqual({
			type: 'error',
			code: COMIC_ERROR_CODES.INVALID_REQUEST,
			message: 'Invalid request',
			retryable: false,
		});
		expect(JSON.stringify(body)).not.toContain(leak);
		expect(body).not.toHaveProperty('stack');
	});

	it('returns a stable 409 body', async () => {
		const response = errorToResponse(
			new ComicEditorError({
				code: COMIC_ERROR_CODES.DOMAIN_INVARIANT,
				message: 'Revision conflict',
				retryable: true,
				status: 409,
				shotId: 'shot-1',
			}),
		);
		const body = await readError(response);

		expect(response.status).toBe(409);
		expect(body).toEqual({
			type: 'error',
			code: COMIC_ERROR_CODES.DOMAIN_INVARIANT,
			message: 'Revision conflict',
			retryable: true,
			shotId: 'shot-1',
		});
		expect(body).not.toHaveProperty('stack');
	});

	it('returns a stable 413 body', async () => {
		const response = errorToResponse(
			new ComicEditorError({
				code: COMIC_ERROR_CODES.PAYLOAD_TOO_LARGE,
				message: 'Request body is too large',
				retryable: false,
				status: 413,
			}),
		);
		const body = await readError(response);

		expect(response.status).toBe(413);
		expect(body).toEqual({
			type: 'error',
			code: COMIC_ERROR_CODES.PAYLOAD_TOO_LARGE,
			message: 'Request body is too large',
			retryable: false,
		});
		expect(body).not.toHaveProperty('stack');
	});

	it('returns a stable 422 body', async () => {
		const response = errorToResponse(
			new ComicEditorError({
				code: COMIC_ERROR_CODES.DOMAIN_INVARIANT,
				message: 'Shot overlap is invalid',
				retryable: false,
				status: 422,
				shotId: 'shot-1',
				itemId: 'item-1',
				assetId: 'asset-1',
			}),
		);
		const body = await readError(response);

		expect(response.status).toBe(422);
		expect(body).toEqual({
			type: 'error',
			code: COMIC_ERROR_CODES.DOMAIN_INVARIANT,
			message: 'Shot overlap is invalid',
			retryable: false,
			shotId: 'shot-1',
			itemId: 'item-1',
			assetId: 'asset-1',
		});
		expect(body).not.toHaveProperty('stack');
	});

	it('returns a stable 500 body without leaking the stack', async () => {
		const secret = 'super-secret-stack-frame';
		const error = new Error(`database password=${secret}`);
		error.stack = `Error: database password=${secret}\n    at secretFunction (${secret}:1:1)`;

		const response = errorToResponse(error);
		const body = await readError(response);
		const serialized = JSON.stringify(body);

		expect(response.status).toBe(500);
		expect(body).toEqual({
			type: 'error',
			code: COMIC_ERROR_CODES.INTERNAL,
			message: 'Internal error',
			retryable: false,
		});
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain('secretFunction');
		expect(body).not.toHaveProperty('stack');
	});
});

describe('runComposeRoute observation', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('logs request metadata and counts without the project or signed query', async () => {
		const lines: string[] = [];
		vi.spyOn(console, 'info').mockImplementation((message) => {
			lines.push(String(message));
		});
		const signed = 'https://cdn.example.com/a.png?X-Amz-Signature=secret-token';
		const response = await runComposeRoute(
			new Request('https://editor.local/api/compose/project/summary', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-request-id': 'req-1',
				},
				body: JSON.stringify({
					project: {
						items: {panel: {id: 'panel'}},
						shots: [{id: 'shot-1'}],
						assets: {secret: {remoteUrl: signed}},
						marker: 'full-project-marker',
					},
				}),
			}),
			() => {
				return {ok: true};
			},
		);
		const logged = JSON.parse(
			lines.find((line) => line.includes('req-1')) ?? '{}',
		) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(response.headers.get('x-request-id')).toBe('req-1');
		expect(logged).toMatchObject({
			requestId: 'req-1',
			operation: 'project/summary',
			itemCount: 1,
			shotCount: 1,
			assetCount: 1,
		});
		expect(logged.durationMs).toEqual(expect.any(Number));
		expect(JSON.stringify(logged)).not.toContain('secret-token');
		expect(JSON.stringify(logged)).not.toContain('full-project-marker');
		expect(JSON.stringify(logged)).not.toContain('X-Amz-Signature');
		expect(logged).not.toHaveProperty('stack');
	});

	it('logs a stable error code and omits the stack', async () => {
		const lines: string[] = [];
		vi.spyOn(console, 'info').mockImplementation((message) => {
			lines.push(String(message));
		});
		const secret = 'super-secret-stack-frame';
		const error = new Error(`database password=${secret}`);
		error.stack = `Error: database password=${secret}`;

		const response = await runComposeRoute(
			new Request('https://editor.local/api/compose/project/validate', {
				method: 'POST',
				headers: {'x-request-id': 'req-500'},
				body: JSON.stringify({project: {shots: []}}),
			}),
			() => {
				throw error;
			},
		);
		const logged = JSON.parse(
			lines.find((line) => line.includes('req-500')) ?? '{}',
		) as Record<string, unknown>;

		expect(response.status).toBe(500);
		expect(logged).toMatchObject({
			requestId: 'req-500',
			operation: 'project/validate',
			code: COMIC_ERROR_CODES.INTERNAL,
			shotCount: 0,
		});
		expect(JSON.stringify(logged)).not.toContain(secret);
		expect(JSON.stringify(logged)).not.toContain('stack');
	});
});
