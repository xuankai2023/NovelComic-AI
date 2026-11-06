export type EditorFeedbackMessages = {
	upload: {
		failed: string;
		fileTooLarge: string;
		fileTooLargeTitle: string;
		noCredentialsTitle: string;
		processingFailed: string;
	};
};

const defaultFeedbackMessages: EditorFeedbackMessages = {
	upload: {
		failed: '上传失败',
		fileTooLarge: '文件过大，无法上传',
		fileTooLargeTitle: '文件过大',
		noCredentialsTitle: '上传凭证缺失',
		processingFailed: '素材处理失败',
	},
};

let currentFeedbackMessages = defaultFeedbackMessages;

export const setEditorFeedbackMessages = (messages: EditorFeedbackMessages) => {
	currentFeedbackMessages = messages;
};

export const getEditorFeedbackMessages = () => currentFeedbackMessages;
