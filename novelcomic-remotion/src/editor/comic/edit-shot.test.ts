import {describe, expect, it} from 'vitest';
import type {AudioItem} from '../items/audio/audio-item-type';
import type {ImageItem} from '../items/image/image-item-type';
import {createComicProject} from '../compose/build-state';
import {addDialogue} from './add-dialogue';
import {ComicEditorError} from './errors';
import {editShot} from './edit-shot';
import type {Shot} from './types';
import {upsertShot} from './upsert-shot';

const image = (
	id: string,
	shotId: string,
	from: number,
	durationInFrames: number,
): ImageItem => {
	return {
		id,
		type: 'image',
		assetId: `${id}-asset`,
		durationInFrames,
		from,
		top: 0,
		left: 0,
		width: 10,
		height: 10,
		opacity: 1,
		isDraggingInTimeline: false,
		borderRadius: 0,
		rotation: 0,
		keepAspectRatio: true,
		fadeInDurationInSeconds: 0,
		fadeOutDurationInSeconds: 0,
		cropLeft: 0,
		cropTop: 0,
		cropRight: 0,
		cropBottom: 0,
		shotId,
		layerId: id,
	};
};

const audio = (
	id: string,
	from: number,
	durationInFrames: number,
): AudioItem => {
	return {
		id,
		type: 'audio',
		assetId: `${id}-asset`,
		durationInFrames,
		from,
		top: 0,
		left: 0,
		width: 10,
		height: 10,
		opacity: 1,
		isDraggingInTimeline: false,
		audioStartFromInSeconds: 0,
		decibelAdjustment: 0,
		playbackRate: 1,
		audioFadeInDurationInSeconds: 0,
		audioFadeOutDurationInSeconds: 0,
	};
};

const withLayer = (
	project: ReturnType<typeof createComicProject>,
	shotId: string,
	item: ImageItem,
) => {
	const trackId = `track-${shotId}`;
	return {
		...project,
		tracks: [
			...project.tracks,
			{
				id: trackId,
				items: [item.id],
				hidden: false,
				muted: false,
				shotId,
				semantic: 'background' as const,
			},
		],
		items: {
			...project.items,
			[item.id]: item,
		},
		shots: project.shots?.map((shot) => {
			if (shot.id !== shotId) {
				return shot;
			}

			return {
				...shot,
				layerTrackIds: [...shot.layerTrackIds, trackId],
			};
		}),
	};
};

const withAudio = (
	project: ReturnType<typeof createComicProject>,
	shotId: string,
	item: AudioItem,
) => {
	return {
		...project,
		tracks: [
			...project.tracks,
			{
				id: `audio-${shotId}`,
				items: [item.id],
				hidden: false,
				muted: false,
				shotId,
				semantic: 'effect' as const,
			},
		],
		items: {
			...project.items,
			[item.id]: item,
		},
	};
};

const shot = (
	project: ReturnType<typeof createComicProject>,
	shotId: string,
): Shot => {
	const found = project.shots?.find((entry) => entry.id === shotId);
	if (!found) {
		throw new Error(`missing ${shotId}`);
	}

	return found;
};

const timeline = () => {
	let project = upsertShot(createComicProject(), {
		shotId: 'a',
		name: 'A',
		durationInFrames: 120,
		transitionOut: {type: 'crossfade', durationInFrames: 15},
		cameraMotion: {
			keyframes: [
				{frame: 0, scale: 1},
				{frame: 119, scale: 1.08},
			],
		},
	});
	project = upsertShot(project, {
		shotId: 'b',
		name: 'B',
		durationInFrames: 120,
	});
	project = upsertShot(project, {
		shotId: 'c',
		name: 'C',
		durationInFrames: 90,
	});
	project = withLayer(project, 'a', image('layer-a', 'a', 0, 120));
	project = withLayer(project, 'b', image('layer-b', 'b', 105, 120));
	project = withLayer(project, 'c', image('layer-c', 'c', 225, 90));
	project = withAudio(project, 'b', audio('audio-b', 110, 10));
	project = withAudio(project, 'c', audio('audio-c', 240, 10));
	project = addDialogue(project, {
		lines: [
			{
				lineId: 'line-a',
				shotId: 'a',
				text: '前',
				from: 10,
				durationInFrames: 20,
			},
			{
				lineId: 'line-b',
				shotId: 'b',
				text: '中',
				from: 110,
				durationInFrames: 20,
			},
			{
				lineId: 'line-c',
				shotId: 'c',
				text: '后',
				from: 230,
				durationInFrames: 20,
			},
		],
	});
	return project;
};

describe('editShot', () => {
	it('shifts later shots, dialogue, layers, and audio across a crossfade', () => {
		const project = timeline();
		const snapshot = structuredClone(project);
		const edited = editShot(project, {
			shotId: 'b',
			durationInFrames: 90,
		});

		expect(project).toEqual(snapshot);
		expect(shot(edited, 'a')).toMatchObject({
			from: 0,
			durationInFrames: 120,
			transitionOut: {type: 'crossfade', durationInFrames: 15},
		});
		expect(shot(edited, 'b')).toMatchObject({from: 105, durationInFrames: 90});
		expect(shot(edited, 'c')).toMatchObject({from: 195, durationInFrames: 90});
		expect(edited.items['layer-a']).toMatchObject({from: 0, durationInFrames: 120});
		expect(edited.items['layer-b']).toMatchObject({from: 105, durationInFrames: 90});
		expect(edited.items['layer-c']).toMatchObject({from: 195, durationInFrames: 90});
		expect(edited.items['dialogue:a:line-a']).toMatchObject({from: 10});
		expect(edited.items['dialogue:b:line-b']).toMatchObject({from: 110});
		expect(edited.items['dialogue:c:line-c']).toMatchObject({from: 200});
		expect(edited.items['audio-b']).toMatchObject({from: 110});
		expect(edited.items['audio-c']).toMatchObject({from: 210});
	});

	it('reflows a new crossfade and clears camera motion', () => {
		let project = upsertShot(createComicProject(), {
			shotId: 'a',
			durationInFrames: 100,
			cameraMotion: {
				keyframes: [
					{frame: 0, x: 0},
					{frame: 99, x: 12},
				],
			},
		});
		project = upsertShot(project, {shotId: 'b', durationInFrames: 80});
		project = withLayer(project, 'b', image('layer-b', 'b', 100, 80));
		project = addDialogue(project, {
			lines: [
				{
					lineId: 'line-b',
					shotId: 'b',
					text: '后',
					from: 100,
					durationInFrames: 10,
				},
			],
		});
		const edited = editShot(project, {
			shotId: 'a',
			name: 'Opening',
			transitionOut: {type: 'crossfade', durationInFrames: 15},
			cameraMotion: null,
		});

		expect(shot(edited, 'a').name).toBe('Opening');
		expect(shot(edited, 'a').cameraMotion).toBeUndefined();
		expect(shot(edited, 'a').transitionOut).toEqual({
			type: 'crossfade',
			durationInFrames: 15,
		});
		expect(shot(edited, 'b').from).toBe(85);
		expect(edited.items['layer-b']).toMatchObject({
			from: 85,
			durationInFrames: 80,
		});
		expect(edited.items['dialogue:b:line-b']).toMatchObject({from: 85});
	});

	it('rejects a shrink that pushes dialogue outside and leaves the project unchanged', () => {
		let project = upsertShot(createComicProject(), {
			shotId: 'a',
			durationInFrames: 100,
		});
		project = addDialogue(project, {
			lines: [
				{
					lineId: 'line-a',
					shotId: 'a',
					text: '长对白',
					from: 10,
					durationInFrames: 80,
				},
			],
		});
		const snapshot = structuredClone(project);

		expect(() => {
			editShot(project, {shotId: 'a', durationInFrames: 50});
		}).toThrow(ComicEditorError);
		expect(project).toEqual(snapshot);
	});

	it('rejects a shorter duration that cuts existing camera keyframes', () => {
		const project = upsertShot(createComicProject(), {
			shotId: 'a',
			durationInFrames: 100,
			cameraMotion: {
				keyframes: [
					{frame: 0, scale: 1},
					{frame: 80, scale: 1.1},
				],
			},
		});

		expect(() => {
			editShot(project, {shotId: 'a', durationInFrames: 50});
		}).toThrow(/Camera keyframe frame must lie inside the duration/);
	});

	it('rejects an unknown shot', () => {
		expect(() => {
			editShot(createComicProject(), {shotId: 'missing', name: 'nope'});
		}).toThrow(/does not exist/);
	});
});
