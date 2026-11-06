import {parseMedia} from '@remotion/media-parser';
import {universalReader} from '@remotion/media-parser/universal';

export type VideoProbeResult = {
	durationInSeconds: number;
	width: number;
	height: number;
	hasAudioTrack: boolean;
	fps: number | null;
	mimeType: string | null;
	size: number | null;
	name: string;
};

const PROBE_FIELDS = {
	dimensions: true,
	durationInSeconds: true,
	tracks: true,
	size: true,
	name: true,
	mimeType: true,
	fps: true,
} as const;

const isContentRangeUnsupportedError = (err: unknown): boolean => {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes('Content-Range');
};

const urlBasename = (url: string): string => {
	try {
		const pathname = new URL(url).pathname;
		return pathname.split('/').pop() || 'video.mp4';
	} catch {
		return 'video.mp4';
	}
};

const probeFromUrl = async (url: string) => {
	return parseMedia({
		src: url,
		reader: universalReader,
		fields: PROBE_FIELDS,
		acknowledgeRemotionLicense: true,
	});
};

const probeFromBlob = async (url: string) => {
	// eslint-disable-next-line no-console
	console.log(
		`[字幕] 【探测 fallback】源站不支持 Content-Range，改为完整下载后解析 url=${url}`,
	);
	const startedAt = Date.now();
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`下载视频失败（fallback 探测）：HTTP ${response.status} ${response.statusText}`,
		);
	}
	const blob = await response.blob();
	// eslint-disable-next-line no-console
	console.log(
		`[字幕] 【探测 fallback】下载完成 大小=${(blob.size / 1024 / 1024).toFixed(2)}MB 耗时=${Math.round(Date.now() - startedAt)}ms`,
	);

	return parseMedia({
		src: blob,
		fields: PROBE_FIELDS,
		acknowledgeRemotionLicense: true,
	});
};

export const probeVideo = async (url: string): Promise<VideoProbeResult> => {
	let result: Awaited<ReturnType<typeof probeFromUrl>>;
	try {
		result = await probeFromUrl(url);
	} catch (err) {
		if (!isContentRangeUnsupportedError(err)) {
			throw err;
		}
		result = await probeFromBlob(url);
	}

	const dimensions = result.dimensions;
	if (!dimensions) {
		throw new Error('Could not determine video dimensions');
	}

	const durationInSeconds = result.durationInSeconds;
	if (durationInSeconds === null || durationInSeconds === undefined) {
		throw new Error('Could not determine video duration');
	}

	const hasAudioTrack = result.tracks.some((t) => t.type === 'audio');

	return {
		durationInSeconds,
		width: dimensions.width,
		height: dimensions.height,
		hasAudioTrack,
		fps: result.fps ?? null,
		mimeType: result.mimeType ?? null,
		size: result.size ?? null,
		name: result.name || urlBasename(url),
	};
};
