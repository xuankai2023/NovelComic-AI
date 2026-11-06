import {createEmptyState} from '../../../../src/editor/compose/build-state';
import {
	buildVideoAsset,
	fitMediaToCanvas,
	resolveVideoInput,
	VideoInput,
} from '../../../../src/editor/compose/build-video-item';
import {VideoItem} from '../../../../src/editor/items/video/video-item-type';
import {UndoableState} from '../../../../src/editor/state/types';
import {generateRandomId} from '../../../../src/editor/utils/generate-random-id';

export const runtime = 'nodejs';

type OverlayRequestBody = {
	project?: UndoableState;
	videoUrl: string;
	startMs: number;
	scale?: number;
	video?: VideoInput;
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	muted?: boolean;
	decibelAdjustment?: number;
	durationMs?: number;
	sourceStartMs?: number;
	borderRadius?: number;
	fadeInMs?: number;
	fadeOutMs?: number;
};

type OverlayResponse =
	| {type: 'success'; project: UndoableState}
	| {type: 'error'; error: string};

const optionalFiniteNumber = (value: unknown, field: string) => {
	if (value !== undefined && !Number.isFinite(value)) {
		throw new Error(`${field} must be a finite number`);
	}
};

export async function POST(request: Request) {
	try {
		const body = (await request.json()) as OverlayRequestBody;

		if (!body.videoUrl || typeof body.videoUrl !== 'string') {
			throw new Error('videoUrl 是必填参数');
		}

		if (body.startMs === undefined || typeof body.startMs !== 'number') {
			throw new Error('startMs 是必填参数（毫秒数）');
		}

		if (body.startMs < 0) {
			throw new Error('startMs 不能小于 0');
		}

		optionalFiniteNumber(body.left, 'left');
		optionalFiniteNumber(body.top, 'top');
		optionalFiniteNumber(body.width, 'width');
		optionalFiniteNumber(body.height, 'height');
		optionalFiniteNumber(body.decibelAdjustment, 'decibelAdjustment');
		optionalFiniteNumber(body.durationMs, 'durationMs');
		optionalFiniteNumber(body.sourceStartMs, 'sourceStartMs');
		optionalFiniteNumber(body.borderRadius, 'borderRadius');
		optionalFiniteNumber(body.fadeInMs, 'fadeInMs');
		optionalFiniteNumber(body.fadeOutMs, 'fadeOutMs');

		const scale = body.scale ?? 0.8;
		if (scale <= 0 || scale > 1) {
			throw new Error('scale 必须在 (0, 1] 之间');
		}
		if ((body.width === undefined) !== (body.height === undefined)) {
			throw new Error('width 和 height 必须同时提供');
		}
		if (body.width !== undefined && body.width <= 0) {
			throw new Error('width 必须大于 0');
		}
		if (body.height !== undefined && body.height <= 0) {
			throw new Error('height 必须大于 0');
		}
		if (body.durationMs !== undefined && body.durationMs <= 0) {
			throw new Error('durationMs 必须大于 0');
		}
		if (body.sourceStartMs !== undefined && body.sourceStartMs < 0) {
			throw new Error('sourceStartMs 不能小于 0');
		}

		const videoInput: VideoInput = {
			remoteUrl: body.videoUrl,
			...body.video,
		};
		const resolvedVideo = await resolveVideoInput(videoInput);

		let state: UndoableState;
		if (body.project) {
			state = body.project;
		} else {
			state = createEmptyState({
				compositionWidth: resolvedVideo.width,
				compositionHeight: resolvedVideo.height,
			});
		}

		const fps = state.fps;
		const fromFrame = Math.round((body.startMs / 1000) * fps);
		const sourceStartInSeconds = (body.sourceStartMs ?? 0) / 1000;
		if (sourceStartInSeconds >= resolvedVideo.durationInSeconds) {
			throw new Error('sourceStartMs 必须早于视频素材结束时间');
		}

		const asset = buildVideoAsset(resolvedVideo);

		const fitted =
			body.width !== undefined && body.height !== undefined
				? {
						width: Math.round(body.width),
						height: Math.round(body.height),
						top: Math.round(
							body.top ?? (state.compositionHeight - body.height) / 2,
						),
						left: Math.round(
							body.left ?? (state.compositionWidth - body.width) / 2,
						),
					}
				: fitMediaToCanvas({
						mediaWidth: asset.width,
						mediaHeight: asset.height,
						containerWidth: Math.round(state.compositionWidth * scale),
						containerHeight: Math.round(state.compositionHeight * scale),
					});

		const sourceAvailableFrames = Math.floor(
			(asset.durationInSeconds - sourceStartInSeconds) * fps,
		);
		const durationInFrames =
			body.durationMs === undefined
				? sourceAvailableFrames
				: Math.min(
						Math.round((body.durationMs / 1000) * fps),
						sourceAvailableFrames,
					);
		if (durationInFrames <= 0) {
			throw new Error('叠加视频时长为空，请检查 durationMs 或 sourceStartMs');
		}

		const overlayItem: VideoItem = {
			id: generateRandomId(),
			type: 'video',
			durationInFrames,
			from: fromFrame,
			assetId: asset.id,
			top: Math.round(body.top ?? fitted.top),
			left: Math.round(body.left ?? fitted.left),
			width: fitted.width,
			height: fitted.height,
			opacity: 1,
			borderRadius: body.borderRadius ?? 0,
			rotation: 0,
			videoStartFromInSeconds: sourceStartInSeconds,
			decibelAdjustment: body.decibelAdjustment ?? 0,
			playbackRate: 1,
			audioFadeInDurationInSeconds: 0,
			audioFadeOutDurationInSeconds: 0,
			fadeInDurationInSeconds: (body.fadeInMs ?? 0) / 1000,
			fadeOutDurationInSeconds: (body.fadeOutMs ?? 0) / 1000,
			keepAspectRatio: true,
			isDraggingInTimeline: false,
			cropBottom: 0,
			cropTop: 0,
			cropLeft: 0,
			cropRight: 0,
		};

		const overlayTrack = {
			id: generateRandomId(),
			items: [overlayItem.id],
			hidden: false,
			muted: body.muted ?? true,
		};

		state = {
			...state,
			items: {...state.items, [overlayItem.id]: overlayItem},
			assets: {...state.assets, [asset.id]: asset},
			tracks: [overlayTrack, ...state.tracks],
		};

		const response: OverlayResponse = {type: 'success', project: state};
		return Response.json(response);
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error('Compose overlay error:', e);
		const response: OverlayResponse = {
			type: 'error',
			error: e instanceof Error ? e.message : 'Unknown error',
		};
		return Response.json(response, {status: 400});
	}
}
