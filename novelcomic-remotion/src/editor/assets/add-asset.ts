import {toast} from 'sonner';
import {TimelineWriteOnlyContext} from '../context-provider';
import {getEditorFeedbackMessages} from '../i18n/editor-feedback-messages';
import {addAssetToState} from '../state/actions/add-asset-to-state';
import {getErrorStack, performAssetUpload} from '../utils/asset-upload-utils';
import {getUploadUrls} from '../utils/use-uploader';
import {makeAsset} from './make-asset';

const innerAddAsset = async ({
	file,
	timelineWriteContext,
	filename,
}: {
	file: Blob;
	timelineWriteContext: TimelineWriteOnlyContext;
	filename: string;
}) => {
	const {setState} = timelineWriteContext;

	// Try to get upload URLs, but don't fail if this doesn't work
	const presignResultPromise = getUploadUrls(file, filename);

	const asset = await makeAsset({
		file,
		remoteUrl: null,
		remoteFileKey: null,
		filename,
	});

	setState({
		update: (state) => addAssetToState({state, asset}),
		commitToUndoStack: true,
		command: {type: 'asset.add'},
	});

	// Handle cloud upload or local-only mode
	await performAssetUpload({setState, asset, presignResultPromise, file});
};

export const addAsset = async ({
	file,
	filename,
	timelineWriteContext,
}: {
	file: Blob;
	filename: string;
	timelineWriteContext: TimelineWriteOnlyContext;
}) => {
	try {
		await innerAddAsset({
			file,
			timelineWriteContext,
			filename,
		});
	} catch (error: unknown) {
		const message = getErrorStack(error);
		toast.error(getEditorFeedbackMessages().upload.processingFailed, {
			description: message,
		});
	}
};
