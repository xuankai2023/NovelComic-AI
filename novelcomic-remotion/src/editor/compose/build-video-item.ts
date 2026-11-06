import {VideoAsset} from '../assets/assets';
import {VideoItem} from '../items/video/video-item-type';
import {generateRandomId} from '../utils/generate-random-id';
import {probeVideo} from './probe-video';

export type VideoInput = {
	remoteUrl: string;
	filename?: string;
	durationInSeconds?: number;
	width?: number;
	height?: number;
	hasAudioTrack?: boolean;
	size?: number;
	mimeType?: string;
	remoteFileKey?: string;
};

export type ResolvedVideoInput = {
	remoteUrl: string;
	filename: string;
	durationInSeconds: number;
	width: number;
	height: number;
	hasAudioTrack: boolean;
	size: number;
	mimeType: string;
	remoteFileKey?: string;
};

export const resolveVideoInput = async (
	video: VideoInput,
): Promise<ResolvedVideoInput> => {
	const needsProbe =
		video.durationInSeconds === undefined ||
		video.width === undefined ||
		video.height === undefined;

	if (needsProbe) {
		const probed = await probeVideo(video.remoteUrl);
		return {
			remoteUrl: video.remoteUrl,
			filename:
				video.filename ?? probed.name ?? urlToFilename(video.remoteUrl),
			durationInSeconds: video.durationInSeconds ?? probed.durationInSeconds,
			width: video.width ?? probed.width,
			height: video.height ?? probed.height,
			hasAudioTrack: video.hasAudioTrack ?? probed.hasAudioTrack,
			size: video.size ?? probed.size ?? 0,
			mimeType: video.mimeType ?? probed.mimeType ?? 'video/mp4',
			remoteFileKey: video.remoteFileKey,
		};
	}

	return {
		remoteUrl: video.remoteUrl,
		filename: video.filename ?? urlToFilename(video.remoteUrl),
		durationInSeconds: video.durationInSeconds!,
		width: video.width!,
		height: video.height!,
		hasAudioTrack: video.hasAudioTrack ?? false,
		size: video.size ?? 0,
		mimeType: video.mimeType ?? 'video/mp4',
		remoteFileKey: video.remoteFileKey,
	};
};

function urlToFilename(url: string): string {
	try {
		const pathname = new URL(url).pathname;
		const name = pathname.split('/').pop();
		return name || 'video.mp4';
	} catch {
		return 'video.mp4';
	}
}

export const buildVideoAsset = (video: ResolvedVideoInput): VideoAsset => {
	return {
		id: generateRandomId(),
		type: 'video',
		filename: video.filename,
		durationInSeconds: video.durationInSeconds,
		hasAudioTrack: video.hasAudioTrack,
		width: video.width,
		height: video.height,
		size: video.size,
		mimeType: video.mimeType,
		remoteUrl: video.remoteUrl,
		remoteFileKey: video.remoteFileKey ?? null,
	};
};

export const buildVideoItem = ({
	asset,
	fromFrame,
	fps,
	compositionWidth,
	compositionHeight,
}: {
	asset: VideoAsset;
	fromFrame: number;
	fps: number;
	compositionWidth: number;
	compositionHeight: number;
}): VideoItem => {
	const durationInFrames = Math.floor(asset.durationInSeconds * fps);

	const {width, height, top, left} = fitMediaToCanvas({
		mediaWidth: asset.width,
		mediaHeight: asset.height,
		containerWidth: compositionWidth,
		containerHeight: compositionHeight,
	});

	return {
		id: generateRandomId(),
		type: 'video',
		durationInFrames,
		from: fromFrame,
		assetId: asset.id,
		top,
		left,
		width,
		height,
		opacity: 1,
		borderRadius: 0,
		rotation: 0,
		videoStartFromInSeconds: 0,
		decibelAdjustment: 0,
		playbackRate: 1,
		audioFadeInDurationInSeconds: 0,
		audioFadeOutDurationInSeconds: 0,
		fadeInDurationInSeconds: 0,
		fadeOutDurationInSeconds: 0,
		keepAspectRatio: true,
		isDraggingInTimeline: false,
		cropBottom: 0,
		cropTop: 0,
		cropLeft: 0,
		cropRight: 0,
	};
};

export function fitMediaToCanvas({
	mediaWidth,
	mediaHeight,
	containerWidth,
	containerHeight,
}: {
	mediaWidth: number;
	mediaHeight: number;
	containerWidth: number;
	containerHeight: number;
}): {width: number; height: number; top: number; left: number} {
	const heightRatio = containerHeight / mediaHeight;
	const widthRatio = containerWidth / mediaWidth;
	const ratio = Math.min(heightRatio, widthRatio);

	const newWidth = Math.round(mediaWidth * ratio);
	const newHeight = Math.round(mediaHeight * ratio);

	return {
		width: newWidth,
		height: newHeight,
		top: Math.round((containerHeight - newHeight) / 2),
		left: Math.round((containerWidth - newWidth) / 2),
	};
}
