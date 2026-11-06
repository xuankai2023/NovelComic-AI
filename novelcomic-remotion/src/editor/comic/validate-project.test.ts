import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import {createComicProject} from '../compose/build-state';
import type {ImageItem} from '../items/image/image-item-type';
import {addDialogue} from './add-dialogue';
import {appendImageSequence, panelIds} from './append-image-sequence';
import {upsertShot} from './upsert-shot';
import {validateProject} from './validate-project';

const hosts = ['cdn.example.com'];

const sequenced = () => {
	return appendImageSequence(createComicProject(), {
		allowedHosts: hosts,
		images: [
			{
				shotId: 'shot-1',
				url: 'https://cdn.example.com/one.png',
				width: 1080,
				height: 1920,
				durationInFrames: 60,
				cameraPresetId: 'camera-push',
			},
			{
				shotId: 'shot-2',
				url: 'https://cdn.example.com/two.png',
				width: 1080,
				height: 1920,
				durationInFrames: 60,
			},
		],
	});
};

const codes = (project: ReturnType<typeof sequenced>) => {
	return validateProject(project)
		.filter((issue) => issue.severity === 'error')
		.map((issue) => issue.code);
};

describe('validateProject', () => {
	it('accepts a sequenced project and still reports v1 reference issues', () => {
		const project = addDialogue(sequenced(), {
			lines: [
				{
					lineId: 'line-1',
					shotId: 'shot-1',
					text: '你好',
					from: 0,
					durationInFrames: 30,
				},
			],
		});
		expect(codes(project)).toEqual([]);

		const legacy = createComicProject();
		legacy.schemaVersion = 1;
		legacy.shots = [];
		const legacyAsset: ImageAsset = {
			id: 'asset-1',
			type: 'image',
			filename: 'a.png',
			size: 1,
			remoteUrl: 'http://cdn.example.com/a.png',
			remoteFileKey: null,
			mimeType: 'image/png',
			width: 10,
			height: 10,
		};
		const legacyItem: ImageItem = {
			id: 'item-1',
			type: 'image',
			assetId: 'asset-1',
			durationInFrames: 10,
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
		};
		const issues = validateProject({
			...legacy,
			assets: {'asset-1': legacyAsset},
			items: {'item-1': legacyItem},
			tracks: [
				{
					id: 'track-1',
					items: ['item-1', 'missing-item'],
					hidden: false,
					muted: true,
				},
			],
		});
		expect(issues.map((issue) => issue.code)).toEqual([
			'TRACK_MUTED',
			'MISSING_ITEM',
		]);
		expect(issues.some((issue) => issue.code === 'INVALID_REMOTE_URL')).toBe(
			false,
		);
	});

	it('reports shot timing, crossfade, motion, sprite, and unsafe URLs', () => {
		const gapped = sequenced();
		gapped.shots![1]!.from = 1000;
		expect(codes(gapped)).toContain('SHOT_GAP');

		const overlapped = sequenced();
		overlapped.shots![1]!.from = 10;
		expect(codes(overlapped)).toContain('SHOT_OVERLAP');

		const faded = upsertShot(
			upsertShot(createComicProject(), {
				shotId: 'a',
				durationInFrames: 20,
			}),
			{shotId: 'b', durationInFrames: 20},
		);
		faded.shots![0]!.transitionOut = {type: 'crossfade', durationInFrames: 20};
		expect(codes(faded)).toContain('CROSSFADE_RANGE');

		const motion = sequenced();
		const motionItem = motion.items[panelIds('shot-1').itemId] as ImageItem;
		motionItem.motion = {
			transform: {
				keyframes: [{frame: 0, x: 0}],
				loop: 'ping-pong',
				loopStartFrame: 8,
				loopEndFrame: 2,
			},
		};
		expect(codes(motion)).toContain('INVALID_LOOP');

		const invalidTransform = sequenced();
		const invalidTransformItem = invalidTransform.items[
			panelIds('shot-1').itemId
		] as ImageItem;
		invalidTransformItem.motion = {
			transform: {
				x: Number.NaN,
				keyframes: [{frame: 0, anchorX: Number.POSITIVE_INFINITY}],
			},
		};
		expect(codes(invalidTransform)).toContain('INVALID_TRANSFORM');

		const sprite = sequenced();
		const spriteItem = sprite.items[panelIds('shot-1').itemId] as ImageItem;
		spriteItem.motion = {
			spriteStates: [{frame: 0, assetId: 'missing-sprite'}],
		};
		expect(codes(sprite)).toContain('MISSING_SPRITE_ASSET');

		const remote = sequenced();
		const asset = remote.assets[panelIds('shot-1').assetId] as ImageAsset;
		asset.remoteUrl = 'https://192.168.1.8/secret.png';
		expect(codes(remote)).toContain('INVALID_REMOTE_URL');

		const plain = sequenced();
		const plainAsset = plain.assets[panelIds('shot-1').assetId] as ImageAsset;
		plainAsset.remoteUrl = 'http://cdn.example.com/plain.png';
		expect(codes(plain)).toContain('INVALID_REMOTE_URL');
	});

	it('requires every shot layer item to cover the complete shot duration', () => {
		const project = sequenced();
		const panelItem = project.items[panelIds('shot-1').itemId] as ImageItem;
		panelItem.from = 1;
		panelItem.durationInFrames = 59;

		expect(codes(project)).toContain('SHOT_ITEM_TIMING');
	});
});
