import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import type {EditorStarterItem} from '../items/item-type';
import {ComicEditorError} from './errors';
import {planOutputBatches} from './plan-batches';
import type {ShotTransition} from './types';
import {upsertShot} from './upsert-shot';

const FPS = 30;
const frames = (seconds: number): number => seconds * FPS;

const projectWithShots = (
	durations: number[],
	transitions?: Array<ShotTransition | undefined>,
) => {
	let project = createComicProject({fps: FPS});
	durations.forEach((durationInFrames, index) => {
		project = upsertShot(project, {
			shotId: `shot-${index + 1}`,
			durationInFrames,
			transitionOut: transitions?.[index] ?? {type: 'cut'},
		});
	});
	return project;
};

const withItem = (
	project: ReturnType<typeof projectWithShots>,
	item: EditorStarterItem,
	track?: {
		id: string;
		shotId?: string;
		semantic?: 'effect' | 'dialogue';
	},
) => {
	return {
		...project,
		items: {
			...project.items,
			[item.id]: item,
		},
		tracks: track
			? [
					...project.tracks,
					{
						id: track.id,
						items: [item.id],
						hidden: false,
						muted: false,
						shotId: track.shotId,
						semantic: track.semantic,
					},
				]
			: project.tracks,
		shots: project.shots?.map((shot) => {
			if (
				!track?.shotId ||
				shot.id !== track.shotId ||
				item.type !== 'captions'
			) {
				return shot;
			}

			return {
				...shot,
				dialogueItemIds: [...shot.dialogueItemIds, item.id],
			};
		}),
	};
};

describe('planOutputBatches', () => {
	it('keeps 5, 15, and 18 second projects inside one batch', () => {
		const five = planOutputBatches(projectWithShots([frames(5)]));
		expect(five).toHaveLength(1);
		expect(five[0]).toMatchObject({
			fromFrame: 0,
			endFrameInclusive: frames(5) - 1,
			durationInFrames: frames(5),
			shotIds: ['shot-1'],
			reason: 'short-range',
			batchIndex: 1,
		});
		expect(five[0].durationInFrames).toBe(
			five[0].endFrameInclusive - five[0].fromFrame + 1,
		);

		const fifteen = planOutputBatches(projectWithShots([frames(15)]));
		expect(fifteen[0]).toMatchObject({
			durationInFrames: frames(15),
			reason: 'target-range',
		});

		const eighteen = planOutputBatches(projectWithShots([frames(18)]));
		expect(eighteen[0]).toMatchObject({
			durationInFrames: frames(18),
			endFrameInclusive: frames(18) - 1,
			reason: 'target-range',
		});

		const capped = planOutputBatches(projectWithShots([frames(18), frames(6)]));
		expect(capped.map((batch) => batch.durationInFrames)).toEqual([
			frames(18),
			frames(6),
		]);
		expect(capped[1].fromFrame).toBe(capped[0].endFrameInclusive + 1);
	});

	it('rejects a single shot longer than 18 seconds', () => {
		const project = projectWithShots([frames(18) + 1]);
		const snapshot = structuredClone(project);
		expect(() => planOutputBatches(project)).toThrow(
			expect.objectContaining({
				code: 'DOMAIN_INVARIANT',
				shotId: 'shot-1',
				message: expect.stringMatching(/Shot shot-1 exceeds 18 seconds/),
			}),
		);
		expect(project).toEqual(snapshot);
	});

	it('refuses to cut a dialogue line that crosses a shot boundary', () => {
		const boundary = frames(10);
		const project = withItem(
			projectWithShots([frames(10), frames(10)]),
			{
				id: 'line-1',
				type: 'captions',
				from: boundary - 5,
				durationInFrames: 10,
			} as EditorStarterItem,
			{id: 'dialogue-track', shotId: 'shot-1', semantic: 'dialogue'},
		);

		expect(() => planOutputBatches(project)).toThrow(
			expect.objectContaining({
				code: 'DOMAIN_INVARIANT',
				message: expect.stringMatching(/cannot be split/),
			}),
		);
	});

	it('keeps a crossfade inside one batch when the union still fits', () => {
		const project = projectWithShots(
			[frames(16), frames(3)],
			[{type: 'crossfade', durationInFrames: frames(1)}, {type: 'cut'}],
		);
		expect(project.shots?.[1]?.from).toBe(frames(15));
		const snapshot = structuredClone(project);
		const batches = planOutputBatches(project);

		expect(project).toEqual(snapshot);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toMatchObject({
			shotIds: ['shot-1', 'shot-2'],
			fromFrame: 0,
			endFrameInclusive: frames(18) - 1,
			durationInFrames: frames(18),
		});
		expect(batches[0].durationInFrames).not.toBe(frames(19));
	});

	it('does not treat background music as a protected cut', () => {
		const project = withItem(
			projectWithShots([frames(10), frames(10)]),
			{
				id: 'bgm',
				type: 'audio',
				from: 0,
				durationInFrames: frames(20),
			} as EditorStarterItem,
			{id: 'bgm-track'},
		);
		const batches = planOutputBatches(project);
		expect(batches.map((batch) => batch.shotIds)).toEqual([
			['shot-1'],
			['shot-2'],
		]);
	});

	it('protects a shot-owned sound effect that crosses the boundary', () => {
		const boundary = frames(10);
		const project = withItem(
			projectWithShots([frames(10), frames(10)]),
			{
				id: 'hit',
				type: 'audio',
				from: boundary - 4,
				durationInFrames: 8,
			} as EditorStarterItem,
			{id: 'sfx-track', shotId: 'shot-1', semantic: 'effect'},
		);
		expect(() => planOutputBatches(project)).toThrow(
			expect.objectContaining({
				code: 'DOMAIN_INVARIANT',
				message: expect.stringMatching(/sound effects/),
			}),
		);
	});

	it('moves the fewest complete shots to rebalance a short tail', () => {
		const project = projectWithShots([
			frames(14),
			frames(2),
			frames(2),
			frames(1),
		]);
		const batches = planOutputBatches(project);
		expect(batches.map((batch) => batch.shotIds)).toEqual([
			['shot-1'],
			['shot-2', 'shot-3', 'shot-4'],
		]);
		expect(batches.map((batch) => batch.durationInFrames)).toEqual([
			frames(14),
			frames(5),
		]);
		expect(batches.every((batch) => batch.reason === 'tail-rebalance')).toBe(
			true,
		);
		expect(batches[1].fromFrame).toBe(batches[0].endFrameInclusive + 1);
	});

	it('returns TAIL_REBALANCE_FAILED when the short tail cannot move', () => {
		const project = projectWithShots([frames(18), frames(4)]);
		const snapshot = structuredClone(project);
		expect(() => planOutputBatches(project)).toThrow(ComicEditorError);
		expect(() => planOutputBatches(project)).toThrow(
			expect.objectContaining({code: 'TAIL_REBALANCE_FAILED'}),
		);
		expect(project).toEqual(snapshot);

		expect(() =>
			planOutputBatches(projectWithShots([frames(4), frames(15)])),
		).toThrow(expect.objectContaining({code: 'TAIL_REBALANCE_FAILED'}));
	});

	it('covers a 20 shot project without missing or repeated frames', () => {
		const project = projectWithShots(Array.from({length: 20}, () => frames(2)));
		const batches = planOutputBatches(project);
		const durations = batches.map((batch) => batch.durationInFrames);
		expect(durations).toEqual([frames(18), frames(16), frames(6)]);
		expect(
			batches.every(
				(batch) =>
					batch.durationInFrames >= frames(5) &&
					batch.durationInFrames <= frames(18),
			),
		).toBe(true);
		expect(
			durations.filter((duration) => duration >= frames(15)).length,
		).toBeGreaterThan(batches.length / 2);

		expect(batches[0].fromFrame).toBe(0);
		for (let index = 0; index < batches.length - 1; index++) {
			expect(batches[index + 1].fromFrame).toBe(
				batches[index].endFrameInclusive + 1,
			);
			expect(batches[index].durationInFrames).toBe(
				batches[index].endFrameInclusive - batches[index].fromFrame + 1,
			);
		}

		expect(batches.at(-1)?.endFrameInclusive).toBe(frames(40) - 1);
		expect(batches.flatMap((batch) => batch.shotIds)).toEqual(
			Array.from({length: 20}, (_, index) => `shot-${index + 1}`),
		);
		expect(new Set(batches.map((batch) => batch.batchId)).size).toBe(
			batches.length,
		);
	});

	it('changes batchId when the boundary or project content changes', () => {
		const fifteen = planOutputBatches(projectWithShots([frames(15)]));
		const again = planOutputBatches(projectWithShots([frames(15)]));
		const eighteen = planOutputBatches(projectWithShots([frames(18)]));
		expect(fifteen[0].batchId).toBe(again[0].batchId);
		expect(fifteen[0].batchId).not.toBe(eighteen[0].batchId);

		const renamed = projectWithShots([frames(15)]);
		renamed.shots = renamed.shots?.map((shot) => {
			return {...shot, name: 'renamed'};
		});
		expect(planOutputBatches(renamed)[0].batchId).not.toBe(fifteen[0].batchId);
	});
});
