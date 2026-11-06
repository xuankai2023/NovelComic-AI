import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import type {ImageItem} from '../items/image/image-item-type';
import {evaluateImagePose} from '../motion/evaluate';
import {comicProjectV2} from '../motion/fixtures/comic-project-v2';
import type {UndoableState} from '../state/types';
import {toCompositionProps} from './to-composition-props';
import {validateRenderPayload} from './validate-render-payload';

const imageAsset = (id: string): ImageAsset => {
	return {
		id,
		type: 'image',
		filename: `${id}.png`,
		size: 1,
		remoteUrl: `https://cdn.example.com/${id}.png`,
		remoteFileKey: null,
		mimeType: 'image/png',
		width: 100,
		height: 100,
	};
};

const imageItem = (overrides: Partial<ImageItem> = {}): ImageItem => {
	return {
		id: 'image-1',
		type: 'image',
		assetId: 'asset-main',
		durationInFrames: 30,
		from: 15,
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
		...overrides,
	};
};

describe('toCompositionProps', () => {
	it('keeps comic fields when adapting a project', () => {
		const before = structuredClone(comicProjectV2);
		const props = toCompositionProps(comicProjectV2);

		expect(comicProjectV2).toEqual(before);
		expect(props.shots).toEqual(comicProjectV2.shots);
		expect(props.tracks).toEqual(comicProjectV2.tracks);
		expect(props.items).toEqual(comicProjectV2.items);
		expect(props.assets).toEqual(comicProjectV2.assets);
		expect(props.compositionWidth).toBe(1080);
		expect(props.compositionHeight).toBe(1920);
		expect(props.fps).toBe(30);
		expect(props.fontInfos).toEqual({});
		expect(props.shots?.[0]?.cameraMotion?.keyframes.at(-1)?.scale).toBe(1.08);
		expect(props.items['item-shot-a-character']).toMatchObject({
			motion: {preset: {id: 'breathing'}},
		});
		expect(props.items['item-shot-a-eye']).toMatchObject({
			motion: {
				spriteStates: [
					{frame: 0, assetId: 'asset-eye-open'},
					{frame: 40, assetId: 'asset-eye-closed'},
					{frame: 46, assetId: 'asset-eye-open'},
				],
			},
		});
	});

	it('fills an empty shot list for a v1 project', () => {
		const item = imageItem();
		const project: UndoableState = {
			tracks: [
				{
					id: 'track-1',
					items: [item.id],
					hidden: false,
					muted: false,
				},
			],
			assets: {'asset-main': imageAsset('asset-main')},
			items: {[item.id]: item},
			fps: 30,
			compositionWidth: 1080,
			compositionHeight: 1920,
			deletedAssets: [],
		};

		expect(toCompositionProps(project).shots).toEqual([]);
	});

	it('returns parsed shots and rejects a missing shot or sprite asset', () => {
		const item = imageItem({
			shotId: 'shot-a',
			motion: {
				spriteStates: [
					{frame: 0, assetId: 'asset-open'},
					{frame: 4, assetId: 'asset-closed'},
				],
			},
		});
		const payload = {
			compositionWidth: 1080,
			compositionHeight: 1920,
			fps: 30,
			tracks: [
				{
					id: 'track-1',
					items: [item.id],
					hidden: false,
					muted: false,
				},
			],
			items: {[item.id]: item},
			assets: {
				'asset-main': imageAsset('asset-main'),
				'asset-open': imageAsset('asset-open'),
				'asset-closed': imageAsset('asset-closed'),
			},
			shots: comicProjectV2.shots,
		};

		expect(validateRenderPayload(payload).shots).toEqual(comicProjectV2.shots);
		expect(() =>
			validateRenderPayload({
				...payload,
				shots: [],
			}),
		).toThrow(/references missing shot shot-a/);
		expect(() =>
			validateRenderPayload({
				...payload,
				assets: {
					'asset-main': imageAsset('asset-main'),
					'asset-open': imageAsset('asset-open'),
				},
			}),
		).toThrow(/asset for item image-1 is missing/);

		const legacy = imageItem();
		expect(
			validateRenderPayload({
				...payload,
				items: {[legacy.id]: legacy},
				assets: {'asset-main': imageAsset('asset-main')},
				shots: undefined,
			}).shots,
		).toEqual([]);
	});

	it('preserves the exact transform evaluation used by editor preview and render', () => {
		const item = imageItem({
			left: 20,
			top: 30,
			width: 200,
			height: 100,
			motion: {
				transform: {
					animatedProperties: ['position', 'scale', 'rotation', 'opacity'],
					anchorX: 0.25,
					anchorY: 0.75,
					keyframes: [
						{frame: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1},
						{frame: 10, x: 100, y: 50, scaleX: 2, scaleY: 0.5, rotation: 30, opacity: 0.4},
					],
				},
			},
		});
		const project: UndoableState = {
			tracks: [{id: 'track-1', items: [item.id], hidden: false, muted: false}],
			assets: {'asset-main': imageAsset('asset-main')},
			items: {[item.id]: item},
			fps: 30,
			compositionWidth: 1080,
			compositionHeight: 1920,
			deletedAssets: [],
		};
		const renderItem = toCompositionProps(project).items[item.id];
		if (renderItem.type !== 'image') throw new Error('expected image');
		const input = {
			shot: null,
			globalFrame: item.from + 5,
			compositionWidth: 1080,
			compositionHeight: 1920,
			fadeOpacity: 1,
		};

		expect(evaluateImagePose({...input, item: renderItem})).toEqual(
			evaluateImagePose({...input, item}),
		);
	});
});
