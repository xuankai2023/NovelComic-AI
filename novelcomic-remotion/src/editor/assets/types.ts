export type PresignResponse = {
	readUrl: string;
	presignedUrl: string;
	fileKey: string;
};

export type PresignErrorCode =
	| 'INTERNAL_ERROR'
	| 'UNKNOWN_ERROR'
	| '404_ERROR'
	| 'FILE_TOO_LARGE'
	| 'NO_CREDENTIALS'
	| 'INVALID_REQUEST';

export interface PresignErrorResponse {
	code: PresignErrorCode;
	message: string;
}
