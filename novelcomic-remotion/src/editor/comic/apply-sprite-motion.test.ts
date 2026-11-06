import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import {createComicProject} from '../compose/build-state';
import type {ImageItem} from '../items/image/image-item-type';
import {addDialogue, dialogueIds} from './add-dialogue';
import {applySpriteMotion} from './apply-sprite-motion';
import {upsertShot} from './upsert-shot';

const imageAsset = (id: string): ImageAsset => {
	return {
		id,
		type: 'image',
		filename: `${id}.png`,
		size: 1,
		remoteUrl: `https://cdn.test/${id}.png`,
		remoteFileKey: null,
		mimeType: 'image/png',
		width: 100,
		height: 100,
	};
};

const imageItem = (): ImageItem => {
	return {
		id: 'face',
		type: 'image',
		assetId: 'eye-open',
		spriteAssetIds: [
			'eye-open',
			'eye-closed',
			'mouth-closed',
			'mouth-half',
			'mouth-open',
		],
		durationInFrames: 90,
		from: 0,
		top: 0,
		left: 0,
		width: 100,
		height: 100,
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
		shotId: 'shot-1',
		layerId: 'face',
	};
};

const projectWithFace = () => {
	const base = upsertShot(createComicProject(), {
		shotId: 'shot-1',
		durationInFrames: 90,
	});
	const item = imageItem();
	return {
		...base,
		tracks: [
			{
				id: 'track:shot-1:face',
				items: [item.id],
				hidden: false,
				muted: false,
				shotId: 'shot-1',
				semantic: 'body' as const,
			},
		],
		items: {[item.id]: item},
		assets: Object.fromEntries(
			item.spriteAssetIds!.map((id) => [id, imageAsset(id)]),
		),
		shots: base.shots?.map((shot) => {
			return {...shot, layerTrackIds: ['track:shot-1:face']};
		}),
	};
};

describe('applySpriteMotion', () => {
	it('writes deterministic blink states inside the image duration', () => {
		const project = projectWithFace();
		const input = {
			itemId: 'face',
			mode: 'replace' as const,
			sprite: {
				kind: 'blink' as const,
				openAssetId: 'eye-open',
				closedAssetId: 'eye-closed',
				seed: 42,
			},
		};
		const first = applySpriteMotion(project, input);
		const second = applySpriteMotion(project, input);
		const states =
			first.items.face?.type === 'image'
				? first.items.face.motion?.spriteStates
				: undefined;

		expect(states).toEqual(
			second.items.face?.type === 'image'
				? second.items.face.motion?.spriteStates
				: undefined,
		);
		expect(states?.length).toBeGreaterThan(1);
		expect(states?.every((state) => state.frame >= 0 && state.frame < 90)).toBe(
			true,
		);
		expect(project.items.face).not.toHaveProperty('motion');
	});

	it('derives mouth ranges from dialogue items and rejects append conflicts', () => {
		const withDialogue = addDialogue(projectWithFace(), {
			lines: [
				{
					shotId: 'shot-1',
					lineId: 'line-1',
					text: '你好',
					from: 15,
					durationInFrames: 30,
				},
			],
		});
		const mouthed = applySpriteMotion(withDialogue, {
			itemId: 'face',
			mode: 'replace',
			sprite: {
				kind: 'mouth-flap',
				closedAssetId: 'mouth-closed',
				halfAssetId: 'mouth-half',
				openAssetId: 'mouth-open',
				dialogueItemIds: [dialogueIds('shot-1', 'line-1').itemId],
			},
		});
		const states =
			mouthed.items.face?.type === 'image'
				? mouthed.items.face.motion?.spriteStates
				: undefined;

		expect(states?.some((state) => state.frame >= 15 && state.frame < 45)).toBe(
			true,
		);
		expect(() => {
			applySpriteMotion(mouthed, {
				itemId: 'face',
				mode: 'append',
				sprite: {
					kind: 'blink',
					openAssetId: 'eye-open',
					closedAssetId: 'eye-closed',
					seed: 1,
				},
			});
		}).toThrow(/conflicts/);
	});

	it('writes phoneme-aligned mouth states without dialogue items', () => {
		const mouthed = applySpriteMotion(projectWithFace(), {
			itemId: 'face',
			mode: 'replace',
			sprite: {
				kind: 'mouth-flap',
				closedAssetId: 'mouth-closed',
				halfAssetId: 'mouth-half',
				openAssetId: 'mouth-open',
				phonemeCues: [
					{from: 12, durationInFrames: 4, phoneme: 'B'},
					{from: 16, durationInFrames: 6, phoneme: 'AH'},
					{from: 30, durationInFrames: 5, mouthShape: 'closed'},
				],
			},
		});
		const states =
			mouthed.items.face?.type === 'image'
				? mouthed.items.face.motion?.spriteStates
				: undefined;

		expect(states).toEqual([
			{frame: 0, assetId: 'mouth-closed'},
			{frame: 12, assetId: 'mouth-half'},
			{frame: 16, assetId: 'mouth-open'},
			{frame: 22, assetId: 'mouth-closed'},
		]);
		expect(
			mouthed.items.face?.type === 'image'
				? mouthed.items.face.spriteAssetIds
				: [],
		).toEqual(
			expect.arrayContaining(['mouth-closed', 'mouth-half', 'mouth-open']),
		);
	});
});
