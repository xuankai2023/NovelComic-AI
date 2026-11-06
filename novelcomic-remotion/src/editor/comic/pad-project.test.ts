import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import type {ImageItem} from '../items/image/image-item-type';
import type {EditorStarterItem} from '../items/item-type';
import {padProjectToMinimumDuration} from './pad-project';
import {planOutputBatches} from './plan-batches';
import {upsertShot} from './upsert-shot';

const image = (shotId: string, durationInFrames: number): ImageItem => {
	return {
		id: `image-${shotId}`,
		type: 'image',
		assetId: `asset-${shotId}`,
		durationInFrames,
		from: 0,
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
		layerId: `layer-${shotId}`,
	};
};

describe('padProjectToMinimumDuration', () => {
	it('leaves planning unchanged and returns a new project only when padding', () => {
		let project = upsertShot(createComicProject({fps: 30}), {
			shotId: 'shot-1',
			durationInFrames: 60,
		});
		const layer = image('shot-1', 60);
		const trackId = 'track-shot-1';
		project = {
			...project,
			tracks: [
				{
					id: trackId,
					items: [layer.id],
					hidden: false,
					muted: false,
					shotId: 'shot-1',
					semantic: 'background',
				},
			],
			items: {
				...project.items,
				[layer.id]: layer,
				'line-1': {
					id: 'line-1',
					type: 'captions',
					from: 0,
					durationInFrames: 30,
				} as EditorStarterItem,
			},
			shots: project.shots?.map((shot) => {
				return {
					...shot,
					layerTrackIds: [trackId],
					dialogueItemIds: ['line-1'],
				};
			}),
		};
		const snapshot = structuredClone(project);

		expect(() => planOutputBatches(project)).toThrow(
			expect.objectContaining({
				code: 'DOMAIN_INVARIANT',
				message: expect.stringMatching(/pad it before planning/),
			}),
		);
		expect(project).toEqual(snapshot);

		const padded = padProjectToMinimumDuration(project);
		expect(padded).not.toBe(project);
		expect(project).toEqual(snapshot);
		expect(padded.shots?.[0]).toMatchObject({
			id: 'shot-1',
			from: 0,
			durationInFrames: 150,
		});
		expect(padded.items[layer.id]).toMatchObject({
			from: 0,
			durationInFrames: 150,
		});
		expect(padded.items['line-1']).toMatchObject({
			from: 0,
			durationInFrames: 30,
		});

		const paddedSnapshot = structuredClone(padded);
		const batches = planOutputBatches(padded);
		expect(padded).toEqual(paddedSnapshot);
		expect(batches).toHaveLength(1);
		expect(batches[0].durationInFrames).toBe(150);

		const longEnough = upsertShot(createComicProject({fps: 30}), {
			shotId: 'shot-1',
			durationInFrames: 180,
		});
		expect(padProjectToMinimumDuration(longEnough)).toBe(longEnough);
	});
});
