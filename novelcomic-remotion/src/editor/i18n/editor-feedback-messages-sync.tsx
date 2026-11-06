'use client';

import {useTranslations} from 'next-intl';
import {useEffect} from 'react';
import {setEditorFeedbackMessages} from './editor-feedback-messages';

export const EditorFeedbackMessagesSync: React.FC = () => {
	const tUpload = useTranslations('editor.feedback.upload');

	useEffect(() => {
		setEditorFeedbackMessages({
			upload: {
				failed: tUpload('failed'),
				fileTooLarge: tUpload('fileTooLarge'),
				fileTooLargeTitle: tUpload('fileTooLargeTitle'),
				noCredentialsTitle: tUpload('noCredentialsTitle'),
				processingFailed: tUpload('processingFailed'),
			},
		});
	}, [tUpload]);

	return null;
};
