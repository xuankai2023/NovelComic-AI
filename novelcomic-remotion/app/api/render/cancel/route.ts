import {getRenderBackendForHandle} from '../../../../src/editor/rendering/render-backend';
import type {
	CancelRenderPayload,
	CancelRenderResponse,
} from '../../../../src/editor/rendering/types';

export const runtime = 'nodejs';

const isCancelPayload = (value: unknown): value is CancelRenderPayload => {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<CancelRenderPayload>;
	return (
		typeof candidate.bucketName === 'string' &&
		candidate.bucketName.length > 0 &&
		typeof candidate.renderId === 'string' &&
		/^[A-Za-z0-9-]{1,80}$/.test(candidate.renderId)
	);
};

export async function POST(request: Request) {
	try {
		const body: unknown = await request.json();
		if (!isCancelPayload(body)) {
			return Response.json(
				{
					type: 'error',
					code: 'INVALID_CANCEL_REQUEST',
					message: 'bucketName and renderId are required.',
					retryable: false,
				} satisfies CancelRenderResponse,
				{status: 400},
			);
		}

		const result = await getRenderBackendForHandle(body).cancel(body);
		if (result.type === 'unsupported') {
			return Response.json(result, {status: 409});
		}
		if (result.type === 'error') {
			return Response.json(result, {status: result.retryable ? 503 : 409});
		}
		return Response.json(result);
	} catch (error) {
		const response: CancelRenderResponse = {
			type: 'error',
			code: 'CANCEL_FAILED',
			message:
				error instanceof Error ? error.message : 'Unable to cancel render.',
			retryable: true,
		};
		return Response.json(response, {status: 503});
	}
}
