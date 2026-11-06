import {describe, expect, it} from 'vitest';
import {upsertShot} from '../comic/upsert-shot';
import {createComicProject} from '../compose/build-state';
import {
	createShotFromPanel,
	deleteShotFromPanel,
	updateShotFromPanel,
} from './shot-panel-actions';

describe('shot panel actions', () => {
	it('creates a shot at the current frame when the project has no shots', () => {
		const project = createComicProject({fps: 30});
		const next = createShotFromPanel({
			project,
			fps: 30,
			currentFrame: 42,
			createId: () => 'shot:a',
		});

		expect(next.shots).toEqual([
			{
				id: 'shot:a',
				name: 'Shot 1',
				from: 42,
				durationInFrames: 150,
				layerTrackIds: [],
				dialogueItemIds: [],
				transitionOut: {type: 'cut'},
			},
		]);
	});

	it('edits duration and reflows following shots', () => {
		const first = createShotFromPanel({
			project: createComicProject({fps: 30}),
			fps: 30,
			currentFrame: 0,
			createId: () => 'shot:a',
		});
		const second = createShotFromPanel({
			project: first,
			fps: 30,
			currentFrame: 0,
			createId: () => 'shot:b',
		});

		const next = updateShotFromPanel({
			project: second,
			shotId: 'shot:a',
			name: 'Opening',
			durationInFrames: 90,
			transitionOut: {type: 'crossfade', durationInFrames: 12},
		});

		expect(next.shots?.[0]).toMatchObject({
			id: 'shot:a',
			name: 'Opening',
			from: 0,
			durationInFrames: 90,
			transitionOut: {type: 'crossfade', durationInFrames: 12},
		});
		expect(next.shots?.[1]).toMatchObject({
			id: 'shot:b',
			from: 78,
		});
	});

	it('can move the first shot start frame', () => {
		const project = upsertShot(createComicProject(), {
			shotId: 'shot:a',
			name: 'A',
			from: 10,
			durationInFrames: 60,
		});

		const next = updateShotFromPanel({
			project,
			shotId: 'shot:a',
			name: 'A',
			durationInFrames: 60,
			startFrame: 24,
			transitionOut: {type: 'cut'},
		});

		expect(next.shots?.[0]?.from).toBe(24);
	});

	it('deletes a shot through the domain delete operation', () => {
		const project = createShotFromPanel({
			project: createComicProject(),
			fps: 30,
			currentFrame: 0,
			createId: () => 'shot:a',
		});

		const next = deleteShotFromPanel(project, 'shot:a');
		expect(next.shots).toEqual([]);
	});
});

