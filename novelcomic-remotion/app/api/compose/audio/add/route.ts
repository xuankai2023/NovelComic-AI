import {
	buildAudioAsset,
	buildAudioItem,
	resolveAudioInput,
} from '../../../../../src/editor/compose/build-audio-item';
import {getTimelineEndFrame} from '../../../../../src/editor/compose/build-state';
import {UndoableState} from '../../../../../src/editor/state/types';
import {generateRandomId} from '../../../../../src/editor/utils/generate-random-id';

export const runtime = 'nodejs';

type AudioAddRequestBody = {
	project?: UndoableState;
	audioUrl?: string;
	startMs?: number;
	sourceStartMs?: number;
	durationMs?: number | 'auto_project_duration';
	decibelAdjustment?: number;
	fadeInMs?: number;
	fadeOutMs?: number;
};

type AudioAddResponse =
	| {type: 'success'; project: UndoableState; itemId: string; assetId: string}
	| {type: 'error'; error: string};

const msToFrame = (ms: number, fps: number) => Math.round((ms / 1000) * fps);

const optionalFiniteNumber = (value: unknown, field: string) => {
	if (value !== undefined && !Number.isFinite(value)) {
		throw new Error(`${field} must be a finite number`);
	}
};

export async function POST(request: Request) {
	try {
		const body = (await request.json()) as AudioAddRequestBody;

		if (!body.project) {
			throw new Error('project is required');
		}
		if (!body.audioUrl || typeof body.audioUrl !== 'string') {
			throw new Error('audioUrl is required');
		}

		optionalFiniteNumber(body.startMs, 'startMs');
		optionalFiniteNumber(body.sourceStartMs, 'sourceStartMs');
		optionalFiniteNumber(body.decibelAdjustment, 'decibelAdjustment');
		optionalFiniteNumber(body.fadeInMs, 'fadeInMs');
		optionalFiniteNumber(body.fadeOutMs, 'fadeOutMs');
		if (
			body.durationMs !== undefined &&
			body.durationMs !== 'auto_project_duration' &&
			!Number.isFinite(body.durationMs)
		) {
			throw new Error(
				'durationMs must be a finite number or auto_project_duration',
			);
		}

		const startMs = body.startMs ?? 0;
		const sourceStartMs = body.sourceStartMs ?? 0;
		const fadeInMs = body.fadeInMs ?? 500;
		const fadeOutMs = body.fadeOutMs ?? 1500;
		if (startMs < 0) throw new Error('startMs cannot be negative');
		if (sourceStartMs < 0) throw new Error('sourceStartMs cannot be negative');
		if (fadeInMs < 0) throw new Error('fadeInMs cannot be negative');
		if (fadeOutMs < 0) throw new Error('fadeOutMs cannot be negative');

		const resolvedAudio = await resolveAudioInput({
			remoteUrl: body.audioUrl,
		});

		const fps = body.project.fps;
		const fromFrame = msToFrame(startMs, fps);
		const sourceStartInSeconds = sourceStartMs / 1000;
		if (sourceStartInSeconds >= resolvedAudio.durationInSeconds) {
			throw new Error(
				'sourceStartMs must be before the end of the audio asset',
			);
		}

		const sourceAvailableFrames = Math.floor(
			(resolvedAudio.durationInSeconds - sourceStartInSeconds) * fps,
		);
		const projectEndFrame = getTimelineEndFrame(body.project);
		const projectRemainingFrames =
			projectEndFrame > fromFrame
				? projectEndFrame - fromFrame
				: sourceAvailableFrames;
		const requestedDurationFrames =
			body.durationMs === undefined ||
			body.durationMs === 'auto_project_duration'
				? projectRemainingFrames
				: msToFrame(body.durationMs, fps);

		if (requestedDurationFrames <= 0) {
			throw new Error('durationMs must be greater than 0');
		}

		const durationInFrames = Math.min(
			requestedDurationFrames,
			sourceAvailableFrames,
		);
		if (durationInFrames <= 0) {
			throw new Error('Audio duration is empty after applying sourceStartMs');
		}

		const asset = buildAudioAsset(resolvedAudio);
		const item = buildAudioItem({
			asset,
			fromFrame,
			durationInFrames,
			audioStartFromInSeconds: sourceStartInSeconds,
			decibelAdjustment: body.decibelAdjustment ?? -15,
			audioFadeInDurationInSeconds: fadeInMs / 1000,
			audioFadeOutDurationInSeconds: fadeOutMs / 1000,
		});

		const project: UndoableState = {
			...body.project,
			assets: {...body.project.assets, [asset.id]: asset},
			items: {...body.project.items, [item.id]: item},
			tracks: [
				...body.project.tracks,
				{
					id: generateRandomId(),
					items: [item.id],
					hidden: false,
					muted: false,
				},
			],
		};

		const response: AudioAddResponse = {
			type: 'success',
			project,
			itemId: item.id,
			assetId: asset.id,
		};
		return Response.json(response);
	} catch (e) {
		const response: AudioAddResponse = {
			type: 'error',
			error: e instanceof Error ? e.message : 'Unknown error',
		};
		return Response.json(response, {status: 400});
	}
}
