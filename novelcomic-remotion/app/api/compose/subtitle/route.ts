import type {Caption} from '@remotion/captions';
import {
	type CaptionProvider,
	parseCaptionProvider,
} from '../../../../src/editor/captioning/caption-provider';
import {
	type CaptionAppearanceOptions,
	type CaptionPosition,
	buildCaptionAsset,
	buildCaptionsItem,
} from '../../../../src/editor/compose/build-caption-item';
import {
	appendItemToState,
	appendItemsToTrack,
	createEmptyState,
} from '../../../../src/editor/compose/build-state';
import {
	buildVideoAsset,
	buildVideoItem,
	resolveVideoInput,
} from '../../../../src/editor/compose/build-video-item';
import {
	type CaptionLanguage,
	generateCaptionsFromCOS,
	generateCaptionsFromUrl,
	parseCaptionLanguage,
} from '../../../../src/editor/compose/generate-captions';
import {
	CaptionStyleType,
	isCaptionStyleType,
} from '../../../../src/editor/items/captions/captions-item-type';
import {UndoableState} from '../../../../src/editor/state/types';
import {getServerEnv} from '../../../../src/editor/utils/server-env';

export const runtime = 'nodejs';

const SUBTITLE_PRESET_OPTIONS: CaptionAppearanceOptions = {
	fontFamily: 'Montserrat',
	fontWeight: '900',
	fontSize: 100,
	lineHeight: 1.2,
	color: '#FFFFFF',
	strokeColor: '#0A0909',
	strokeWidth: 8,
	pageDurationInMilliseconds: 1000,
};

const DEFAULT_CAPTION_STYLE_FOR_API: CaptionStyleType = 'animated-background';
const DEFAULT_HIGHLIGHT_COLOR = '#00FF00';
const DEFAULT_LETTER_SPACING = -0.2;

const formatMs = (ms: number) => `${Math.round(ms)}ms`;

// eslint-disable-next-line no-console
const log = (msg: string) => console.log(`[字幕] ${msg}`);

type SubtitleResponse =
	| {type: 'success'; project: UndoableState}
	| {type: 'error'; error: string};

export async function POST(request: Request) {
	const requestStartedAt = Date.now();
	try {
		const body = await request.json();
		const serverEnv = getServerEnv();
		const provider = parseCaptionProvider(body.provider);
		const language = parseCaptionLanguage(body.language);

		const captionStyle: CaptionStyleType = isCaptionStyleType(body.captionStyle)
			? body.captionStyle
			: DEFAULT_CAPTION_STYLE_FOR_API;
		const captionPosition: CaptionPosition = body.captionPosition ?? 'bottom';
		const userOptions = parseCaptionOptions(body.options);
		const captionOptions: CaptionAppearanceOptions = {
			...SUBTITLE_PRESET_OPTIONS,
			highlightColor: userOptions.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR,
			letterSpacing: userOptions.letterSpacing ?? DEFAULT_LETTER_SPACING,
		};

		const mode = body.project ? '工程模式' : body.videoUrl ? '视频URL模式' : '未知';
		log(
			`【第1步】收到请求 模式=${mode} 厂商=${provider} 语言=${language} 样式=${captionStyle} 位置=${captionPosition} 高亮色=${captionOptions.highlightColor} 字距=${captionOptions.letterSpacing}`,
		);

		if (body.project) {
			const response = await handleProjectMode(
				body.project,
				parseItemIds(body.itemIds),
				captionStyle,
				captionPosition,
				captionOptions,
				serverEnv,
				provider,
				language,
			);
			log(
				`【完成】工程模式 总耗时=${formatMs(Date.now() - requestStartedAt)} 状态=${response.type}`,
			);
			return Response.json(response);
		}

		if (body.videoUrl) {
			const response = await handleVideoUrlMode(
				body.videoUrl,
				captionStyle,
				captionPosition,
				captionOptions,
				serverEnv,
				provider,
				language,
			);
			log(
				`【完成】视频URL模式 总耗时=${formatMs(Date.now() - requestStartedAt)} 状态=${response.type}`,
			);
			return Response.json(response);
		}

		throw new Error(
			'请提供 videoUrl（视频地址）或 project（已有工程 JSON），二选一',
		);
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error(
			`[字幕] 【失败】总耗时=${formatMs(Date.now() - requestStartedAt)} 错误=${e instanceof Error ? e.message : 'Unknown'}`,
			e,
		);
		const response: SubtitleResponse = {
			type: 'error',
			error: e instanceof Error ? e.message : 'Unknown error',
		};
		return Response.json(response, {status: 400});
	}
}

async function handleVideoUrlMode(
	videoUrl: string,
	captionStyle: CaptionStyleType,
	captionPosition: CaptionPosition,
	captionOptions: CaptionAppearanceOptions,
	serverEnv: ReturnType<typeof getServerEnv>,
	provider: CaptionProvider,
	language: CaptionLanguage,
): Promise<SubtitleResponse> {
	const probeStartedAt = Date.now();
	log(`【第2步】开始探测视频元数据 url=${videoUrl}`);
	const resolvedVideo = await resolveVideoInput({remoteUrl: videoUrl});
	log(
		`【第2步】视频元数据探测完成 ${resolvedVideo.width}x${resolvedVideo.height} 时长=${resolvedVideo.durationInSeconds.toFixed(1)}s 有音频=${resolvedVideo.hasAudioTrack} 有COS_Key=${Boolean(resolvedVideo.remoteFileKey)} 耗时=${formatMs(Date.now() - probeStartedAt)}`,
	);

	let state = createEmptyState({
		compositionWidth: resolvedVideo.width,
		compositionHeight: resolvedVideo.height,
	});

	const fps = state.fps;
	const videoAsset = buildVideoAsset(resolvedVideo);
	const videoItem = buildVideoItem({
		asset: videoAsset,
		fromFrame: 0,
		fps,
		compositionWidth: state.compositionWidth,
		compositionHeight: state.compositionHeight,
	});

	state = appendItemsToTrack({state, items: [videoItem], assets: [videoAsset]});

	const sttStartedAt = Date.now();
	log(`【第3步】开始调用语音识别（这一步最耗时，可能 10-60 秒）`);
	const captions = await generateCaptionsForMedia(
		videoUrl,
		resolvedVideo.remoteFileKey,
		serverEnv,
		provider,
		language,
	);
	log(
		`【第3步】语音识别 + 后处理完成 字幕条数=${captions.length} 耗时=${formatMs(Date.now() - sttStartedAt)}`,
	);

	const captionAsset = buildCaptionAsset(captions);
	const captionsItem = buildCaptionsItem({
		asset: captionAsset,
		fromFrame: 0,
		fps,
		compositionWidth: state.compositionWidth,
		compositionHeight: state.compositionHeight,
		captionStyle,
		captionPosition,
		captionOptions,
	});

	state = appendItemToState({
		state,
		item: captionsItem,
		asset: captionAsset,
		prepend: true,
	});

	log(`【第4步】工程组装完成 字幕轨已添加到顶层`);
	return {type: 'success', project: state};
}

type MediaSegment = {
	itemId: string;
	mediaUrl: string;
	remoteFileKey: string | undefined;
	startFrame: number;
	durationInFrames: number;
	sourceStartMs: number;
};

async function handleProjectMode(
	project: UndoableState,
	itemIds: string[] | undefined,
	captionStyle: CaptionStyleType,
	captionPosition: CaptionPosition,
	captionOptions: CaptionAppearanceOptions,
	serverEnv: ReturnType<typeof getServerEnv>,
	provider: CaptionProvider,
	language: CaptionLanguage,
): Promise<SubtitleResponse> {
	log(
		`【第2步】扫描工程内的媒体片段 指定itemIds=${itemIds ? itemIds.length : '无（全部）'}`,
	);
	const segments = findAllMediaInProject(project, itemIds);

	if (segments.length === 0) {
		throw new Error('工程中没有找到视频或音频资源，无法生成字幕');
	}

	log(`【第2步】找到 ${segments.length} 个媒体片段需要打字幕`);

	const fps = project.fps;
	let state = project;
	let hasAnyCaptions = false;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const segDurationSec = seg.durationInFrames / fps;
		const segStartedAt = Date.now();
		log(
			`【第3步】片段 ${i + 1}/${segments.length} 开始 itemId=${seg.itemId} 时长=${segDurationSec.toFixed(1)}s 有COS_Key=${Boolean(seg.remoteFileKey)}`,
		);

		const rawCaptions = await generateCaptionsForMedia(
			seg.mediaUrl,
			seg.remoteFileKey,
			serverEnv,
			provider,
			language,
		);
		const segCaptions = trimCaptionsToSegment({
			captions: rawCaptions,
			sourceStartMs: seg.sourceStartMs,
			durationMs: segDurationSec * 1000,
		});

		log(
			`【第3步】片段 ${i + 1}/${segments.length} 完成 识别原始=${rawCaptions.length} 裁剪后=${segCaptions.length} 耗时=${formatMs(Date.now() - segStartedAt)}`,
		);

		if (segCaptions.length === 0) {
			log(
				`【第3步】片段 ${i + 1}/${segments.length} 无有效字幕，跳过（可能是纯背景音）`,
			);
			continue;
		}

		hasAnyCaptions = true;

		const captionAsset = buildCaptionAsset(segCaptions);
		const captionsItem = buildCaptionsItem({
			asset: captionAsset,
			fromFrame: seg.startFrame,
			fps,
			compositionWidth: state.compositionWidth,
			compositionHeight: state.compositionHeight,
			captionStyle,
			captionPosition,
			captionOptions,
		});

		if (captionsItem.durationInFrames > seg.durationInFrames) {
			captionsItem.durationInFrames = seg.durationInFrames;
		}

		state = appendItemToState({
			state,
			item: captionsItem,
			asset: captionAsset,
			prepend: true,
		});
	}

	if (!hasAnyCaptions) {
		throw new Error('未识别到任何语音内容');
	}

	log(`【第4步】所有片段字幕已添加到工程`);
	return {type: 'success', project: state};
}

function parseItemIds(itemIds: unknown): string[] | undefined {
	if (itemIds === undefined || itemIds === null || itemIds === '') {
		return undefined;
	}

	if (typeof itemIds === 'string') {
		return itemIds
			.split(/[\n,]/)
			.map((id) => id.trim())
			.filter(Boolean);
	}

	if (Array.isArray(itemIds) && itemIds.every((id) => typeof id === 'string')) {
		return itemIds.map((id) => id.trim()).filter(Boolean);
	}

	throw new Error('itemIds must be an array of strings');
}

type UserCaptionOptions = {
	highlightColor?: string;
	letterSpacing?: number;
};

function parseCaptionOptions(options: unknown): UserCaptionOptions {
	if (!options || typeof options !== 'object') {
		return {};
	}

	const value = options as Record<string, unknown>;
	const parsed: UserCaptionOptions = {};

	if (typeof value.highlightColor === 'string' && value.highlightColor) {
		parsed.highlightColor = value.highlightColor;
	}

	if (
		typeof value.letterSpacing === 'number' &&
		Number.isFinite(value.letterSpacing)
	) {
		parsed.letterSpacing = value.letterSpacing;
	}

	return parsed;
}

function getSourceStartMs(item: UndoableState['items'][string]): number {
	if (item.type === 'video') {
		return Math.round(item.videoStartFromInSeconds * 1000);
	}

	if (item.type === 'audio') {
		return Math.round(item.audioStartFromInSeconds * 1000);
	}

	return 0;
}

function findAllMediaInProject(
	project: UndoableState,
	itemIds?: string[],
): MediaSegment[] {
	const mutedItemIds = new Set<string>();
	for (const track of project.tracks) {
		if (track.muted) {
			for (const id of track.items) {
				mutedItemIds.add(id);
			}
		}
	}

	const targetItemIdSet = itemIds ? new Set(itemIds) : null;
	if (targetItemIdSet) {
		for (const itemId of targetItemIdSet) {
			if (!project.items[itemId]) {
				throw new Error(`itemIds contains missing item: ${itemId}`);
			}
		}
	}

	const items = targetItemIdSet
		? itemIds!.map((itemId) => project.items[itemId])
		: Object.values(project.items);
	const segments: MediaSegment[] = [];

	for (const item of items) {
		if (item.type !== 'video' && item.type !== 'audio') {
			if (targetItemIdSet) {
				throw new Error(
					`item ${item.id} is ${item.type}, only video/audio items can generate captions`,
				);
			}
			continue;
		}
		if (!targetItemIdSet && mutedItemIds.has(item.id)) continue;

		const asset = project.assets[item.assetId];
		if (!asset || !asset.remoteUrl) continue;
		if (asset.type !== 'video' && asset.type !== 'audio') continue;
		if (asset.type === 'video' && !asset.hasAudioTrack) continue;

		segments.push({
			itemId: item.id,
			mediaUrl: asset.remoteUrl,
			remoteFileKey: asset.remoteFileKey ?? undefined,
			startFrame: item.from,
			durationInFrames: item.durationInFrames,
			sourceStartMs: getSourceStartMs(item),
		});
	}

	segments.sort((a, b) => a.startFrame - b.startFrame);
	return segments;
}

function trimCaptionsToSegment({
	captions,
	sourceStartMs,
	durationMs,
}: {
	captions: Caption[];
	sourceStartMs: number;
	durationMs: number;
}): Caption[] {
	const sourceEndMs = sourceStartMs + durationMs;

	return captions.flatMap((caption) => {
		if (caption.endMs <= sourceStartMs || caption.startMs >= sourceEndMs) {
			return [];
		}

		const startMs = Math.max(0, caption.startMs - sourceStartMs);
		const endMs = Math.min(durationMs, caption.endMs - sourceStartMs);
		const timestampMs =
			caption.timestampMs === null
				? null
				: Math.max(0, caption.timestampMs - sourceStartMs);

		return [
			{
				...caption,
				startMs,
				endMs,
				timestampMs,
			},
		];
	});
}

async function generateCaptionsForMedia(
	mediaUrl: string,
	remoteFileKey: string | undefined,
	serverEnv: ReturnType<typeof getServerEnv>,
	provider: CaptionProvider,
	language: CaptionLanguage,
): Promise<Caption[]> {
	if (remoteFileKey) {
		return generateCaptionsFromCOS({
			fileKey: remoteFileKey,
			openaiApiKey: serverEnv.OPENAI_API_KEY,
			elevenLabsApiKey: serverEnv.ELEVENLABS_API_KEY,
			provider,
			language,
		});
	}

	return generateCaptionsFromUrl({
		url: mediaUrl,
		openaiApiKey: serverEnv.OPENAI_API_KEY,
		elevenLabsApiKey: serverEnv.ELEVENLABS_API_KEY,
		provider,
		language,
	});
}
