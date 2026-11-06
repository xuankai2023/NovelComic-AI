import {
	appendItemsToTrack,
	createEmptyState,
	getTimelineEndFrame,
} from '../../../../src/editor/compose/build-state';
import {
	buildVideoAsset,
	buildVideoItem,
	resolveVideoInput,
	VideoInput,
} from '../../../../src/editor/compose/build-video-item';
import { UndoableState } from '../../../../src/editor/state/types';

export const runtime = 'nodejs';

type ConcatRequestBody = {
	videos: VideoInput[];
	compositionWidth?: number;
	compositionHeight?: number;
	fps?: number;
	existingProject?: UndoableState;
};

type ConcatResponse =
	| { type: 'success'; project: UndoableState }
	| { type: 'error'; error: string };

export async function POST(request: Request) {
	try {
		const body = (await request.json()) as ConcatRequestBody;

		if (!Array.isArray(body.videos) || body.videos.length === 0) {
			throw new Error('videos must be a non-empty array');
		}

		for (let i = 0; i < body.videos.length; i++) {
			if (!body.videos[i].remoteUrl) {
				throw new Error(`videos[${i}].remoteUrl is required`);
			}
		}

		const resolvedVideos = await Promise.all(
			body.videos.map((v) => resolveVideoInput(v)),
		);

		let state: UndoableState;

		if (body.existingProject) {
			state = body.existingProject;
			if (body.compositionWidth)
				state = { ...state, compositionWidth: body.compositionWidth };
			if (body.compositionHeight)
				state = { ...state, compositionHeight: body.compositionHeight };
			if (body.fps) state = { ...state, fps: body.fps };
		} else {
			state = createEmptyState({
				compositionWidth: body.compositionWidth,
				compositionHeight: body.compositionHeight,
				fps: body.fps,
			});
		}

		const fps = state.fps;
		let currentFrame = getTimelineEndFrame(state);

		const videoItems = [];
		const videoAssets = [];

		for (const video of resolvedVideos) {
			const asset = buildVideoAsset(video);
			const item = buildVideoItem({
				asset,
				fromFrame: currentFrame,
				fps,
				compositionWidth: state.compositionWidth,
				compositionHeight: state.compositionHeight,
			});
			videoItems.push(item);
			videoAssets.push(asset);
			currentFrame += item.durationInFrames;
		}

		state = appendItemsToTrack({
			state,
			items: videoItems,
			assets: videoAssets,
		});

		const response: ConcatResponse = { type: 'success', project: state };
		return Response.json(response);
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error('Compose concat error:', e);
		const response: ConcatResponse = {
			type: 'error',
			error: e instanceof Error ? e.message : 'Unknown error',
		};
		return Response.json(response, { status: 400 });
	}
}
