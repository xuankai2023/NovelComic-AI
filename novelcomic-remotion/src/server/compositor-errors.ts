export type CompositorErrorCode =
	| 'INVALID_REQUEST'
	| 'PROJECT_NOT_FOUND'
	| 'PROJECT_EXISTS'
	| 'SNAPSHOT_NOT_FOUND'
	| 'ASSET_NOT_FOUND'
	| 'ASSET_NOT_READY'
	| 'REVISION_CONFLICT'
	| 'IDEMPOTENCY_KEY_REUSED'
	| 'COMMAND_INVALID'
	| 'RENDER_NOT_FOUND'
	| 'RENDER_CANCELED'
	| 'STORAGE_UNAVAILABLE'
	| 'RENDER_FAILED';

export class CompositorServiceError extends Error {
	readonly status: number;
	readonly code: CompositorErrorCode;
	readonly details?: Record<string, unknown>;
	readonly retryable: boolean;

	constructor({
		code,
		message,
		status = 400,
		details,
		retryable = false,
	}: {
		code: CompositorErrorCode;
		message: string;
		status?: number;
		details?: Record<string, unknown>;
		retryable?: boolean;
	}) {
		super(message);
		this.name = 'CompositorServiceError';
		this.code = code;
		this.status = status;
		this.details = details;
		this.retryable = retryable;
	}
}

export const asCompositorError = (error: unknown): CompositorServiceError => {
	if (error instanceof CompositorServiceError) return error;
	return new CompositorServiceError({
		code: 'INVALID_REQUEST',
		message: error instanceof Error ? error.message : 'Invalid request',
	});
};
