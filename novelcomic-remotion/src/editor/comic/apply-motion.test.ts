import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import type {ImageItem} from '../items/image/image-item-type';
import {createComicProject} from '../compose/build-state';
import {applyMotion} from './apply-motion';
import {upsertShot} from './upsert-shot';

const asset = (id: string): ImageAsset => {
	return {
		id,
		type: 'image',
		filename: `${id}.png`,
		size: 1,
		remoteUrl: `https://cdn.example.com/${id}.png`,
		remoteFileKey: null,
		mimeType: 'image/png',
		width: 20,
		height: 20,
	};
};

const image = (durationInFrames = 90): ImageItem => {
	return {
		id: 'hero',
		type: 'image',
		assetId: 'hero-asset',
		durationInFrames,
		from: 0,
		top: 0,
		left: 0,
		width: 20,
		height: 20,
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
		layerId: 'hero',
	};
};

const withImage = (item: ImageItem = image()) => {
	const project = upsertShot(createComicProject(), {
		shotId: 'shot-1',
		durationInFrames: item.durationInFrames,
	});
	return {
		...project,
		assets: {'hero-asset': asset('hero-asset')},
		items: {[item.id]: item},
		tracks: [
			{
				id: 'track-hero',
				items: [item.id],
				hidden: false,
				muted: false,
				shotId: 'shot-1',
				semantic: 'body' as const,
			},
		],
		shots: project.shots?.map((shot) => {
			return {...shot, layerTrackIds: ['track-hero']};
		}),
	};
};

describe('applyMotion', () => {
	it('clamps item and shot presets and keeps the same seed stable', () => {
		const project = withImage();
		const snapshot = structuredClone(project);
		const breathing = applyMotion(project, {
			target: {type: 'item', itemId: 'hero', presetId: 'breathing'},
			mode: 'replace',
			parameters: {scale: 9},
			seed: 4,
		});
		const again = applyMotion(project, {
			target: {type: 'item', itemId: 'hero', presetId: 'breathing'},
			mode: 'replace',
			parameters: {scale: 9},
			seed: 4,
		});
		const floating = applyMotion(project, {
			target: {type: 'item', itemId: 'hero', presetId: 'float'},
			mode: 'replace',
			seed: 4,
		});
		const otherSeed = applyMotion(project, {
			target: {type: 'item', itemId: 'hero', presetId: 'float'},
			mode: 'replace',
			seed: 9,
		});
		const pushed = applyMotion(project, {
			target: {type: 'shot', shotId: 'shot-1', presetId: 'camera-push'},
			mode: 'replace',
			parameters: {scale: 5},
		});
		const hero = breathing.items.hero;
		const motion = hero.type === 'image' ? hero.motion : undefined;

		expect(project).toEqual(snapshot);
		expect(motion?.transform?.keyframes[1]?.scaleX).toBe(1.03);
		expect(motion?.preset).toMatchObject({id: 'breathing', seed: 4});
		expect(breathing.items.hero).toEqual(again.items.hero);
		expect(floating.items.hero).not.toEqual(otherSeed.items.hero);
		const camera = pushed.shots?.[0]?.cameraMotion;
		expect(camera?.keyframes.at(-1)?.scale).toBe(1.2);
		expect(camera?.focalX).toBe(project.compositionWidth / 2);
		expect(camera?.focalY).toBe(project.compositionHeight / 2);
	});

	it('rejects the wrong target, sprite presets, append conflicts, and invalid assets', () => {
		const project = withImage(
			image(90),
		);
		const withKeyframe = applyMotion(project, {
			target: {type: 'item', itemId: 'hero'},
			mode: 'replace',
			keyframes: [{frame: 0, x: 2}],
		});

		expect(() => {
			applyMotion(project, {
				target: {type: 'item', itemId: 'hero', presetId: 'camera-push'},
				mode: 'replace',
			});
		}).toThrow(/does not apply to items/);
		expect(() => {
			applyMotion(project, {
				target: {type: 'shot', shotId: 'shot-1', presetId: 'breathing'},
				mode: 'replace',
			});
		}).toThrow(/does not apply to shots/);
		expect(() => {
			applyMotion(project, {
				target: {type: 'item', itemId: 'hero', presetId: 'blink'},
				mode: 'replace',
			});
		}).toThrow(/requires sprite state assets/);
		expect(() => {
			applyMotion(withKeyframe, {
				target: {type: 'item', itemId: 'hero'},
				mode: 'append',
				keyframes: [{frame: 0, x: 4}],
			});
		}).toThrow(/frame 0 is duplicated/);
		expect(() => {
			applyMotion(
				{
					...project,
					assets: {},
				},
				{
					target: {type: 'item', itemId: 'hero', presetId: 'breathing'},
					mode: 'replace',
				},
			);
		}).toThrow(/invalid asset/);

		const broken = withImage({
			...image(),
			motion: {spriteStates: [{frame: 0, assetId: 'missing-sprite'}]},
		});
		expect(() => {
			applyMotion(broken, {
				target: {type: 'item', itemId: 'hero'},
				mode: 'replace',
				keyframes: [{frame: 4, y: 1}],
			});
		}).toThrow(/invalid asset/);
	});

	it('rejects final animation on an L0 source track', () => {
		const project = withImage();
		project.tracks = project.tracks.map((track) => ({
			...track,
			role: 'source' as const,
		}));

		expect(() =>
			applyMotion(project, {
				target: {type: 'item', itemId: 'hero', presetId: 'hair-sway'},
				mode: 'replace',
			}),
		).toThrow(/L0 source items cannot receive final animation/);
	});
});
