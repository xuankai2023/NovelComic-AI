import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {planContactSheet} from './plan-contact-sheet';
import type {Shot, ShotTransition} from './types';

const shot = (
	id: string,
	from: number,
	durationInFrames: number,
	transitionOut?: ShotTransition,
): Shot => {
	return {
		id,
		name: id,
		from,
		durationInFrames,
		layerTrackIds: [],
		dialogueItemIds: [],
		transitionOut,
	};
};

const projectWith = (shots: Shot[]) => {
	return {
		...createComicProject(),
		shots,
	};
};

describe('planContactSheet', () => {
	it('selects the middle frame of a short shot', () => {
		const project = projectWith([shot('short', 10, 3)]);
		expect(planContactSheet(project)).toEqual([{shotId: 'short', frame: 11}]);
	});

	it('selects a frame outside each side of a crossfade', () => {
		const project = projectWith([
			shot('a', 0, 120, {type: 'crossfade', durationInFrames: 15}),
			shot('b', 105, 120),
		]);

		const frames = planContactSheet(project);

		expect(frames).toEqual([
			{shotId: 'a', frame: 52},
			{shotId: 'b', frame: 172},
		]);
		expect(frames[0]?.frame).toBeLessThan(105);
		expect(frames[1]?.frame).toBeGreaterThanOrEqual(120);
	});

	it('selects the only frame of a one-frame shot', () => {
		const project = projectWith([shot('still', 40, 1)]);
		expect(planContactSheet(project)).toEqual([{shotId: 'still', frame: 40}]);
	});

	it('uses the shot center when a crossfade covers the whole shot', () => {
		const project = projectWith([
			shot('a', 0, 10, {type: 'crossfade', durationInFrames: 6}),
			shot('b', 4, 4, {type: 'crossfade', durationInFrames: 3}),
		]);

		expect(planContactSheet(project)[1]).toEqual({shotId: 'b', frame: 5});
	});

	it('does not modify the project', () => {
		const project = projectWith([
			shot('b', 105, 120),
			shot('a', 0, 120, {type: 'crossfade', durationInFrames: 15}),
		]);
		const before = structuredClone(project);

		expect(planContactSheet(project).map((entry) => entry.shotId)).toEqual([
			'a',
			'b',
		]);
		expect(project).toEqual(before);
	});
});
