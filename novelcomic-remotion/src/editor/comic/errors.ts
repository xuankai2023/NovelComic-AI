export const COMIC_ERROR_CODES = {
	SCHEMA_TOO_NEW: 'SCHEMA_TOO_NEW',
	INVALID_REQUEST: 'INVALID_REQUEST',
	PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
	DOMAIN_INVARIANT: 'DOMAIN_INVARIANT',
	INVALID_REMOTE_URL: 'INVALID_REMOTE_URL',
	LAYER_PACKAGE_FALLBACK_REQUIRED: 'LAYER_PACKAGE_FALLBACK_REQUIRED',
	LAYER_RECOMPOSITION_FAILED: 'LAYER_RECOMPOSITION_FAILED',
	TAIL_REBALANCE_FAILED: 'TAIL_REBALANCE_FAILED',
	DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
	INTERNAL: 'INTERNAL',
} as const;

export type ComicErrorCode =
	(typeof COMIC_ERROR_CODES)[keyof typeof COMIC_ERROR_CODES];

export type ComicEditorErrorOptions = {
	code: ComicErrorCode;
	message: string;
	retryable: boolean;
	status: number;
	shotId?: string;
	itemId?: string;
	assetId?: string;
};

export class ComicEditorError extends Error {
	readonly code: ComicErrorCode;
	readonly retryable: boolean;
	readonly status: number;
	readonly shotId?: string;
	readonly itemId?: string;
	readonly assetId?: string;

	constructor(options: ComicEditorErrorOptions) {
		super(options.message);
		this.name = 'ComicEditorError';
		this.code = options.code;
		this.retryable = options.retryable;
		this.status = options.status;
		this.shotId = options.shotId;
		this.itemId = options.itemId;
		this.assetId = options.assetId;
	}
}

export const unimplemented = (
	operation: string,
	...used: readonly unknown[]
): never => {
	const error = new ComicEditorError({
		code: COMIC_ERROR_CODES.INTERNAL,
		message: `${operation} is not implemented`,
		retryable: false,
		status: 501,
	});
	error.cause = used;
	throw error;
};

export const domainInvariant = (
	message: string,
	ids?: {
		shotId?: string;
		itemId?: string;
		assetId?: string;
	},
): ComicEditorError => {
	return new ComicEditorError({
		code: COMIC_ERROR_CODES.DOMAIN_INVARIANT,
		message,
		retryable: false,
		status: 422,
		shotId: ids?.shotId,
		itemId: ids?.itemId,
		assetId: ids?.assetId,
	});
};
