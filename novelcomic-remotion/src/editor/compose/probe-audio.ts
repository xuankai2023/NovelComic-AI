import {parseMedia} from '@remotion/media-parser';
import {universalReader} from '@remotion/media-parser/universal';

export type AudioProbeResult = {
	durationInSeconds: number;
	mimeType: string | null;
	size: number | null;
	name: string;
};

export const probeAudio = async (url: string): Promise<AudioProbeResult> => {
	const result = await parseMedia({
		src: url,
		reader: universalReader,
		fields: {
			durationInSeconds: true,
			size: true,
			name: true,
			mimeType: true,
		},
		acknowledgeRemotionLicense: true,
	});

	const durationInSeconds = result.durationInSeconds;
	if (durationInSeconds === null || durationInSeconds === undefined) {
		throw new Error('Could not determine audio duration');
	}

	return {
		durationInSeconds,
		mimeType: result.mimeType ?? null,
		size: result.size ?? null,
		name: result.name,
	};
};
