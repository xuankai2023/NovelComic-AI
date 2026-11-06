import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import type {ImageItem} from '../items/image/image-item-type';
import {addDialogue} from './add-dialogue';
import {ComicEditorError} from './errors';
import {upsertShot} from './upsert-shot';

const image = (
	id: string,
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
		shotId: 'b',
	};
};

describe('upsertShot', () => {
	it('places a cut on the following frame and updates a repeated shot id', () => {
		const project = createComicProject();
		const first = upsertShot(project, {
			shotId: 'a',
			name: 'A',
			durationInFrames: 100,
		});
		const second = upsertShot(first, {
			shotId: 'b',
			durationInFrames: 40,
		});
		const repeated = upsertShot(second, {
			shotId: 'a',
			name: 'A2',
			durationInFrames: 100,
		});

		expect(second.shots?.map((shot) => shot.from)).toEqual([0, 100]);
		expect(repeated.shots).toHaveLength(2);
		expect(repeated.shots?.[0]?.name).toBe('A2');
		expect(project.shots).toEqual([]);
	});

	it('overlaps only the declared crossfade and shifts later shots', () => {
		let project = upsertShot(createComicProject(), {
			shotId: 'a',
			durationInFrames: 120,
			transitionOut: {type: 'crossfade', durationInFrames: 15},
		});
		project = upsertShot(project, {
			shotId: 'b',
			durationInFrames: 120,
		});
		expect(project.shots?.map((shot) => shot.from)).toEqual([0, 105]);

		const withItem = {
			...project,
			tracks: [
				...project.tracks,
				{
					id: 'track-b',
					items: ['item-b'],
					hidden: false,
					muted: false,
					shotId: 'b',
					semantic: 'background' as const,
				},
			],
			items: {
				...project.items,
				'item-b': image('item-b', 105, 120),
			},
			shots: project.shots?.map((shot) => {
				if (shot.id !== 'b') {
					return shot;
				}

				return {...shot, layerTrackIds: ['track-b']};
			}),
		};
		const shifted = upsertShot(withItem, {
			shotId: 'a',
			durationInFrames: 150,
			transitionOut: {type: 'crossfade', durationInFrames: 15},
		});

		expect(shifted.shots?.[1]?.from).toBe(135);
		expect(shifted.items['item-b']?.from).toBe(135);
		expect(shifted.items['item-b']?.durationInFrames).toBe(120);
		expect(withItem.items['item-b']?.from).toBe(105);
	});

	it('rejects a crossfade that consumes a whole shot and a dialogue line that would fall outside', () => {
		const project = createComicProject();
		expect(() => {
			upsertShot(project, {
				shotId: 'a',
				durationInFrames: 20,
				transitionOut: {type: 'crossfade', durationInFrames: 20},
			});
		}).toThrow(ComicEditorError);
		expect(project.shots).toEqual([]);

		let timed = upsertShot(createComicProject(), {
			shotId: 'a',
			durationInFrames: 30,
		});
		timed = addDialogue(timed, {
			lines: [
				{
					lineId: 'line-1',
					shotId: 'a',
					text: 'hello',
					from: 0,
					durationInFrames: 30,
				},
			],
		});
		const snapshot = structuredClone(timed);
		expect(() => {
			upsertShot(timed, {shotId: 'a', durationInFrames: 10});
		}).toThrow(/falls outside shot/);
		expect(timed).toEqual(snapshot);
	});
});
