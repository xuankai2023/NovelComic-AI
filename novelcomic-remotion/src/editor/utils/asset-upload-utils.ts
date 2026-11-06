/* eslint-disable no-console */
import {toast} from 'sonner';
import {EditorStarterAsset} from '../assets/assets';
import {PresignErrorResponse} from '../assets/types';
import {SetState} from '../context-provider';
import {getEditorFeedbackMessages} from '../i18n/editor-feedback-messages';
import {finishUpload} from '../state/actions/finish-upload';
import {setUploadError} from '../state/actions/set-upload-error';
import {setUploadProgress} from '../state/actions/set-upload-progress';
import {PresignResult, uploadWithProgressUpdates} from './use-uploader';

export interface UploadResult {
	presignedUrl: string;
	readUrl: string;
	fileKey: string;
}

/**
 * Utility function to safely get error message from unknown error
 */
export const getErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		return error.message;
	}
	return 'Unknown error occurred';
};

/**
 * Utility function to safely get error stack from unknown error
 */
export const getErrorStack = (error: unknown): string => {
	if (error instanceof Error) {
		return error.stack || error.message;
	}
	return 'Unknown error';
};

const getPresignErrorMessage = (error: unknown) => {
	if (
		error &&
		typeof error === 'object' &&
		'message' in error &&
		typeof (error as PresignErrorResponse).message === 'string'
	) {
		return (error as PresignErrorResponse).message;
	}

	return getErrorMessage(error);
};

/**
 * Handles the upload attempt with progress tracking and error handling
 */
export const attemptAssetUpload = async ({
	uploadUrls,
	setState,
	asset,
	file,
}: {
	uploadUrls: UploadResult;
	setState: SetState;
	asset: EditorStarterAsset;
	file: Blob;
}): Promise<UploadResult> => {
	await uploadWithProgressUpdates(
		file,
		uploadUrls.presignedUrl,
		(uploadProgress) => {
			setState({
				update: (state) => {
					return setUploadProgress({state, asset, uploadProgress});
				},
				commitToUndoStack: false,
			});
		},
	);

	setState({
		update: (state) => {
			return finishUpload({
				state,
				asset,
				remoteUrl: uploadUrls.readUrl,
				remoteFileKey: uploadUrls.fileKey,
			});
		},
		commitToUndoStack: true,
		command: {type: 'asset.add'},
	});

	return uploadUrls;
};

/**
 * Complete upload workflow - handles URL retrieval, upload attempt, and error states
 */
export const performAssetUpload = async ({
	setState,
	asset,
	presignResultPromise,
	file,
}: {
	setState: SetState;
	asset: EditorStarterAsset;
	presignResultPromise: Promise<PresignResult>;
	file: Blob;
}): Promise<void> => {
	const presignResult = await presignResultPromise;
	const messages = getEditorFeedbackMessages();

	if (presignResult.type === 'file-too-large') {
		setState({
			update: (state) => {
				return setUploadError({
					state,
					asset: asset,
					error: new Error('File too large to upload'),
					canRetry: false,
				});
			},
			commitToUndoStack: false,
		});
		toast.error(messages.upload.fileTooLargeTitle, {
			description: messages.upload.fileTooLarge,
		});

		return;
	}

	if (presignResult.type === 'no-credentials') {
		setState({
			update: (state) => {
				return setUploadError({
					state,
					asset: asset,
					error: new Error(
						'COS upload credentials are not configured on the server',
					),
					canRetry: true,
				});
			},
			commitToUndoStack: false,
		});
		toast.error(messages.upload.noCredentialsTitle, {
			description: messages.upload.failed,
		});
		console.error(
			'COS asset upload failed. Did you configure COS_SECRET_ID, COS_SECRET_KEY, COS_REGION, COS_BUCKET, and COS_CDN_DOMAIN?',
		);
		return;
	}

	if (presignResult.type === 'error') {
		const message = getPresignErrorMessage(presignResult.error);
		setState({
			update: (state) => {
				return setUploadError({
					state,
					asset: asset,
					error: new Error(message),
					canRetry: true,
				});
			},
			commitToUndoStack: false,
		});
		console.error(presignResult.error);
		toast.error(messages.upload.failed, {
			description: message,
		});
		return;
	}

	try {
		// Attempt upload
		await attemptAssetUpload({
			uploadUrls: presignResult.result,
			setState,
			asset,
			file,
		});
	} catch (uploadError) {
		setState({
			update: (state) => {
				return setUploadError({
					state,
					asset: asset,
					error: uploadError as Error,
					canRetry: true,
				});
			},
			commitToUndoStack: false,
		});
		toast.error(messages.upload.failed);
		console.error(uploadError);
	}
};
