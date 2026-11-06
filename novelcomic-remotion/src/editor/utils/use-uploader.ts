import {AssetUploadProgress} from '../assets/assets';
import {PresignErrorResponse, PresignResponse} from '../assets/types';
import {UploadResult} from './asset-upload-utils';
import {getUploadContentType, uploadWithProgress} from './upload';
import {getCurrentUserIdFromUrl} from './upload-key';

export type PresignResult =
	| {
			type: 'success';
			result: UploadResult;
	  }
	| {
			type: 'no-credentials';
	  }
	| {
			type: 'file-too-large';
	  }
	| {
			type: 'error';
			error: unknown;
	  };

export const getUploadUrls = async (
	file: Blob,
	filename?: string,
): Promise<PresignResult> => {
	const presignedResponse = await fetch('/api/upload', {
		method: 'POST',
		body: JSON.stringify({
			size: file.size,
			contentType: getUploadContentType(file),
			filename,
			userId: getCurrentUserIdFromUrl(),
		}),
		headers: {
			'Content-Type': 'application/json',
		},
	});

	if (!presignedResponse.ok) {
		const errorData = await readPresignErrorResponse(presignedResponse);
		if (
			presignedResponse.status === 404 ||
			errorData?.code === 'NO_CREDENTIALS'
		) {
			return {
				type: 'no-credentials',
			};
		}

		if (presignedResponse.status === 413) {
			return {
				type: 'file-too-large',
			};
		}

		return {
			type: 'error',
			error:
				errorData ?? {
					code: 'UNKNOWN_ERROR',
					message: `Upload service returned ${presignedResponse.status}`,
				},
		};
	}

	const result = (await presignedResponse.json()) as PresignResponse;
	return {
		type: 'success',
		result,
	};
};

const readPresignErrorResponse = async (
	response: Response,
): Promise<PresignErrorResponse | null> => {
	try {
		return (await response.json()) as PresignErrorResponse;
	} catch {
		return null;
	}
};

export const uploadWithProgressUpdates = async (
	file: Blob,
	presignedUrl: string,
	onProgress: (progress: AssetUploadProgress) => void,
): Promise<void> => {
	await uploadWithProgress({
		file,
		url: presignedUrl,
		onProgress,
	});
};
