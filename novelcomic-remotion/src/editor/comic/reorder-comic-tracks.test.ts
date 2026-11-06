import {describe, expect, it} from 'vitest';
import type {AudioItem} from '../items/audio/audio-item-type';
import type {ImageItem} from '../items/image/image-item-type';
import type {TrackType, UndoableState} from '../state/types';
import {reorderComicTracks} from './reorder-comic-tracks';

const image = (id: string, from: number): ImageItem => {
	return {
		id,
		type: 'image',
		assetId: `${id}-asset`,
		durationInFrames: 30,
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
	};
};

const audio = (id: string): AudioItem => {
	return {
		id,
		type: 'audio',
		assetId: `${id}-asset`,
		durationInFrames: 30,
		from: 0,
		top: 0,
		left: 0,
		width: 0,
		height: 0,
		opacity: 1,
		isDraggingInTimeline: false,
		audioStartFromInSeconds: 0,
		decibelAdjustment: 0,
		playbackRate: 1,
		audioFadeInDurationInSeconds: 0,
		audioFadeOutDurationInSeconds: 0,
	};
};

const track = (
	id: string,
	itemId: string,
	extra?: Partial<TrackType>,
): TrackType => {
	return {
		id,
		items: [itemId],
		hidden: false,
		muted: false,
		...extra,
	};
};

describe('reorderComicTracks', () => {
	it('is idempotent and places the later crossfade shot above the earlier one', () => {
		const project: UndoableState = {
			schemaVersion: 2,
			fps: 30,
			compositionWidth: 1080,
			compositionHeight: 1920,
			deletedAssets: [],
			shots: [
				{
					id: 'a',
					name: 'a',
					from: 0,
					durationInFrames: 120,
					layerTrackIds: ['track-a-front', 'track-a-back'],
					dialogueItemIds: ['dialogue-a'],
					transitionOut: {type: 'crossfade', durationInFrames: 15},
				},
				{
					id: 'b',
					name: 'b',
					from: 105,
					durationInFrames: 90,
					layerTrackIds: ['track-b'],
					dialogueItemIds: [],
				},
			],
			tracks: [
				track('track-a-back', 'item-a-back', {
					shotId: 'a',
					semantic: 'background',
				}),
				track('track-b', 'item-b', {shotId: 'b', semantic: 'background'}),
				track('track-audio', 'audio-1'),
				track('track-a-front', 'item-a-front', {shotId: 'a', semantic: 'body'}),
				track('track-dialogue', 'dialogue-a', {
					shotId: 'a',
					semantic: 'dialogue',
				}),
				track('track-effect', 'effect-1', {semantic: 'effect'}),
			],
			items: {
				'item-a-back': image('item-a-back', 0),
				'item-b': image('item-b', 105),
				'audio-1': audio('audio-1'),
				'item-a-front': image('item-a-front', 0),
				'dialogue-a': image('dialogue-a', 10),
				'effect-1': image('effect-1', 0),
			},
			assets: {},
		};
		const originalIds = project.tracks.map((entry) => entry.id);
		const once = reorderComicTracks(project);
		const twice = reorderComicTracks(once);

		expect(once.tracks.map((entry) => entry.id)).toEqual([
			'track-dialogue',
			'track-effect',
			'track-b',
			'track-a-front',
			'track-a-back',
			'track-audio',
		]);
		expect(twice.tracks.map((entry) => entry.id)).toEqual(
			once.tracks.map((entry) => entry.id),
		);
		expect(twice).toEqual(once);
		expect(project.tracks.map((entry) => entry.id)).toEqual(originalIds);
	});
});
