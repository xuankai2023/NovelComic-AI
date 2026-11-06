import {AudioAsset} from '../assets/assets';
import {AudioItem} from '../items/audio/audio-item-type';
import {generateRandomId} from '../utils/generate-random-id';
import {probeAudio} from './probe-audio';

export type AudioInput = {
	remoteUrl: string;
};

export type ResolvedAudioInput = {
	remoteUrl: string;
	filename: string;
	durationInSeconds: number;
	size: number;
	mimeType: string;
};

export const resolveAudioInput = async (
	audio: AudioInput,
): Promise<ResolvedAudioInput> => {
	const probed = await probeAudio(audio.remoteUrl);

	return {
		remoteUrl: audio.remoteUrl,
		filename: probed.name ?? urlToFilename(audio.remoteUrl),
		durationInSeconds: probed.durationInSeconds,
		size: probed.size ?? 0,
		mimeType: probed.mimeType ?? 'audio/mpeg',
	};
};

export const buildAudioAsset = (
	audio: ResolvedAudioInput,
	id = generateRandomId(),
): AudioAsset => {
	return {
		id,
		type: 'audio',
		filename: audio.filename,
		durationInSeconds: audio.durationInSeconds,
		size: audio.size,
		mimeType: audio.mimeType,
		remoteUrl: audio.remoteUrl,
		remoteFileKey: null,
	};
};

export const buildAudioItem = ({
	asset,
	fromFrame,
	durationInFrames,
	audioStartFromInSeconds,
	decibelAdjustment,
	audioFadeInDurationInSeconds,
	audioFadeOutDurationInSeconds,
	itemId,
}: {
	asset: AudioAsset;
	fromFrame: number;
	durationInFrames: number;
	audioStartFromInSeconds: number;
	decibelAdjustment: number;
	audioFadeInDurationInSeconds: number;
	audioFadeOutDurationInSeconds: number;
	itemId?: string;
}): AudioItem => {
	return {
		id: itemId ?? generateRandomId(),
		type: 'audio',
		durationInFrames,
		from: fromFrame,
		assetId: asset.id,
		top: 0,
		left: 0,
		width: 100,
		height: 100,
		opacity: 1,
		audioStartFromInSeconds,
		decibelAdjustment,
		playbackRate: 1,
		audioFadeInDurationInSeconds,
		audioFadeOutDurationInSeconds,
		isDraggingInTimeline: false,
	};
};

function urlToFilename(url: string): string {
	try {
		const pathname = new URL(url).pathname;
		const name = pathname.split('/').pop();
		return name || 'audio.mp3';
	} catch {
		return 'audio.mp3';
	}
}
