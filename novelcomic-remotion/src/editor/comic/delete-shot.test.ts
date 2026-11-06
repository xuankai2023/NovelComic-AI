import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import type {ImageItem} from '../items/image/image-item-type';
import {createComicProject} from '../compose/build-state';
import {addDialogue} from './add-dialogue';
import {dialogueIds} from './add-dialogue';
import {deleteShot} from './delete-shot';
import {upsertShot} from './upsert-shot';

const imageAsset = (id: string): ImageAsset => {
	return {
		id,
		type: 'image',
		filename: `${id}.png`,
		size: 1,
		remoteUrl: `https://cdn.example.com/${id}.png`,
		remoteFileKey: null,
		mimeType: 'image/png',
		width: 10,
		height: 10,
	};
};

const image = (
	id: string,
	shotId: string,
	assetId: string,
	from: number,
	durationInFrames: number,
	spriteAssetId?: string,
): ImageItem => {
	return {
		id,
		type: 'image',
		assetId,
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
		motion: spriteAssetId
			? {spriteStates: [{frame: 0, assetId: spriteAssetId}]}
			: undefined,
	};
};

describe('deleteShot', () => {
	it('removes the shot timeline and orphan assets while keeping shared assets', () => {
		let project = upsertShot(createComicProject(), {
			shotId: 'a',
			durationInFrames: 100,
		});
		project = upsertShot(project, {shotId: 'b', durationInFrames: 80});
		const layerA = image('layer-a', 'a', 'shared', 0, 100, 'only-a');
		const layerB = image('layer-b', 'b', 'shared', 100, 80);
		project = {
			...project,
			assets: {
				shared: imageAsset('shared'),
				'only-a': imageAsset('only-a'),
				'only-b': imageAsset('only-b'),
			},
			items: {
				'layer-a': layerA,
				'layer-b': {...layerB, assetId: 'shared'},
			},
			tracks: [
				{
					id: 'track-a',
					items: ['layer-a'],
					hidden: false,
					muted: false,
					shotId: 'a',
					semantic: 'background',
				},
				{
					id: 'track-b',
					items: ['layer-b'],
					hidden: false,
					muted: false,
					shotId: 'b',
					semantic: 'background',
				},
			],
			shots: project.shots?.map((shot) => {
				if (shot.id === 'a') {
					return {...shot, layerTrackIds: ['track-a']};
				}

				if (shot.id === 'b') {
					return {...shot, layerTrackIds: ['track-b']};
				}

				return shot;
			}),
		};
		project = addDialogue(project, {
			lines: [
				{
					lineId: 'line-a',
					shotId: 'a',
					text: '删',
					from: 0,
					durationInFrames: 20,
				},
			],
		});
		const snapshot = structuredClone(project);
		const deleted = deleteShot(project, 'a');

		expect(project).toEqual(snapshot);
		expect(deleted.shots?.map((shot) => shot.id)).toEqual(['b']);
		expect(deleted.shots?.[0]).toMatchObject({from: 0, durationInFrames: 80});
		expect(deleted.items['layer-a']).toBeUndefined();
		expect(deleted.items['dialogue:a:line-a']).toBeUndefined();
		expect(deleted.items['layer-b']).toMatchObject({
			from: 0,
			durationInFrames: 80,
			assetId: 'shared',
		});
		expect(deleted.tracks.map((track) => track.id)).toEqual(['track-b']);
		expect(deleted.assets.shared).toBeDefined();
		expect(deleted.assets['only-b']).toBeDefined();
		expect(deleted.assets['only-a']).toBeUndefined();
		expect(deleted.assets[dialogueIds('a', 'line-a').assetId]).toBeUndefined();
	});

	it('rejects an unknown shot without changing the project', () => {
		const project = createComicProject();
		const snapshot = structuredClone(project);
		expect(() => deleteShot(project, 'missing')).toThrow(/does not exist/);
		expect(project).toEqual(snapshot);
	});
});
