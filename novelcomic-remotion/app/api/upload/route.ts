import {
	PresignErrorResponse,
	PresignResponse,
} from '../../../src/editor/assets/types';
import {
	COSConfigurationError,
	getCOSPresignedPutUrl,
	getCOSReadUrl,
} from '../../../src/editor/utils/cos-client';
import {formatBytes} from '../../../src/editor/utils/format-bytes';
import {
	buildUploadFileKey,
	getUserIdFromUrl,
	sanitizeUserId,
} from '../../../src/editor/utils/upload-key';

export const runtime = 'nodejs';

const generateCOSPresignedUrl = async ({
	contentType,
	contentLength,
	expiresIn,
	filename,
	userId,
}: {
	contentType: string;
	contentLength: number;
	expiresIn: number;
	filename?: string;
	userId?: string;
}): Promise<PresignResponse> => {
	const fileKey = buildUploadFileKey({
		filename,
		userId,
	});

	const presignedUrl = getCOSPresignedPutUrl({
		key: fileKey,
		contentType,
		contentLength,
		expiresInSeconds: expiresIn,
	});
	const readUrl = getCOSReadUrl(fileKey);

	return {presignedUrl, readUrl, fileKey};
};

const MAX_FILE_UPLOAD_SIZE_IN_MB = 1000;

export async function POST(request: Request) {
	try {
		const json = await request.json();
		if (!Number.isFinite(json.size)) {
			return Response.json(
				{
					code: 'INVALID_REQUEST',
					message: 'size is not a number',
				} satisfies PresignErrorResponse,
				{status: 400},
			);
		}
		if (typeof json.contentType !== 'string') {
			return Response.json(
				{
					code: 'INVALID_REQUEST',
					message: 'contentType is not a string',
				} satisfies PresignErrorResponse,
				{status: 400},
			);
		}

		const referer = request.headers.get('referer');
		const userIdFromReferer = referer ? getUserIdFromUrl(referer) : 'default';
		const requestUserId =
			typeof json.userId === 'string'
				? sanitizeUserId(json.userId)
				: userIdFromReferer;

		if (json.size > 1024 * 1024 * MAX_FILE_UPLOAD_SIZE_IN_MB) {
			return Response.json(
				{
					code: 'FILE_TOO_LARGE',
					message: `File may not be over ${MAX_FILE_UPLOAD_SIZE_IN_MB}MB. Yours is ${formatBytes(json.size)}.`,
				},
				{status: 413},
			);
		}

		const response = await generateCOSPresignedUrl({
			contentType: json.contentType || 'application/octet-stream',
			contentLength: json.size,
			expiresIn: 60 * 60 * 24 * 7,
			filename: typeof json.filename === 'string' ? json.filename : undefined,
			userId: requestUserId,
		});

		return Response.json(response);
	} catch (error) {
		if (error instanceof COSConfigurationError) {
			const errorResponse: PresignErrorResponse = {
				code: 'NO_CREDENTIALS',
				message: `COS upload credentials are not configured on the server. Missing: ${error.missingKeys.join(', ')}`,
			};

			return Response.json(errorResponse, {status: 503});
		}

		const errorResponse: PresignErrorResponse = {
			code: 'UNKNOWN_ERROR',
			message: 'Upload service unavailable',
		};

		// eslint-disable-next-line no-console
		console.error('Upload API error:', error);
		return Response.json(errorResponse, {status: 500});
	}
}
