export type VideoCodec = 'h264';

const extensionByCodec: Record<VideoCodec, 'mp4'> = {
	h264: 'mp4',
};
const getTimestampForFileName = () => {
	return new Date().toISOString().replace(/\D/g, '').slice(0, 14);
};


export const getEditorExportFileName = (codec: VideoCodec) => {
	return `cut_video_${getTimestampForFileName()}.${extensionByCodec[codec]}`;
};
