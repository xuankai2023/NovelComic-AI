import {describe, expect, it} from 'vitest';
import type {Shot} from '../comic/types';
import type {ImageItem} from '../items/image/image-item-type';
import {applyEasing} from './easing';
import {
	clearTransformEvaluationCache,
	evaluateImagePose,
	evaluateTransformAtFrame,
	findPreviousCrossfadeShot,
} from './evaluate';
import {comicProjectV2} from './fixtures/comic-project-v2';
import type {TransformAnimation, TransformKeyframe} from './types';

const imageItem = (
	overrides: Partial<ImageItem> & Pick<ImageItem, 'id'>,
): ImageItem => {
	return {
		type: 'image',
		assetId: 'asset-main',
		durationInFrames: 60,
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
		...overrides,
	};
};

const poseOf = (
	item: ImageItem,
	globalFrame: number,
	extra?: {
		shot?: Shot | null;
		previousShot?: Shot | null;
		fadeOpacity?: number;
	},
) => {
	return evaluateImagePose({
		item,
		shot: extra?.shot ?? null,
		previousShot: extra?.previousShot ?? null,
		globalFrame,
		compositionWidth: 1080,
		compositionHeight: 1920,
		fadeOpacity: extra?.fadeOpacity ?? 1,
	});
};

const shot = (overrides: Partial<Shot> & Pick<Shot, 'id' | 'from'>): Shot => {
	return {
		name: overrides.id,
		durationInFrames: 30,
		layerTrackIds: [],
		dialogueItemIds: [],
		...overrides,
	};
};

describe('evaluateImagePose', () => {
	it('keeps malformed curve handles from producing invalid CSS values', () => {
		const pose = poseOf(
			imageItem({
				id: 'invalid-handle',
				motion: {
					transform: {
						keyframes: [
							{frame: 0, x: 0, handleOut: {x: Number.NaN, y: Number.NaN}},
							{frame: 10, x: 100},
						],
					},
				},
			}),
			5,
		);
		expect(Object.values(pose).every((value) => typeof value !== 'number' || Number.isFinite(value))).toBe(true);
	});
	it('evaluates animated anchor point keyframes', () => {
		const pose = poseOf(
			imageItem({
				id: 'animated-anchor',
				motion: {
					transform: {
						keyframes: [
							{frame: 0, anchorX: 0, anchorY: 0},
							{frame: 10, anchorX: 1, anchorY: 1},
						],
					},
				},
			}),
			5,
		);
		expect(pose.anchorX).toBeCloseTo(0.5);
		expect(pose.anchorY).toBeCloseTo(0.5);
	});

	it('keeps a still image identical to its base pose', () => {
		const item = imageItem({
			id: 'still',
			left: 12,
			top: 24,
			width: 100,
			height: 80,
			rotation: 15,
			opacity: 0.8,
		});

		expect(poseOf(item, 10)).toEqual({
			assetId: 'asset-main',
			left: 12,
			top: 24,
			width: 100,
			height: 80,
			rotation: 15,
			opacity: 0.8,
			anchorX: 0.5,
			anchorY: 0.5,
		});
		expect(poseOf(item, 10, {fadeOpacity: 0.5}).opacity).toBeCloseTo(0.4);
	});

	it('does not let a sparse opacity keyframe interrupt x', () => {
		const keyframes: TransformKeyframe[] = [
			{frame: 0, x: 0, opacity: 0, easing: 'linear'},
			{frame: 10, opacity: 1, easing: 'ease-in'},
			{frame: 20, x: 100, easing: 'linear'},
		];
		const item = imageItem({
			id: 'sparse',
			motion: {transform: {keyframes}},
		});

		const midpoint = poseOf(item, 5);
		expect(midpoint.left).toBeCloseTo(25);
		expect(midpoint.opacity).toBeCloseTo(0.125);
		expect(poseOf(item, 10).left).toBeCloseTo(50);
		expect(poseOf(item, 10).opacity).toBeCloseTo(1);
	});

	it('clamps values before the first keyframe and after the last', () => {
		const item = imageItem({
			id: 'clamp',
			motion: {
				transform: {
					keyframes: [
						{frame: 10, x: 4, easing: 'linear'},
						{frame: 20, x: 14, easing: 'linear'},
					],
				},
			},
		});

		expect(poseOf(item, 0).left).toBe(4);
		expect(poseOf(item, 15).left).toBe(9);
		expect(poseOf(item, 40).left).toBe(14);
	});

	it('repeats a closed frame window and ping-pongs without repeating endpoints', () => {
		const keyframes: TransformKeyframe[] = [
			{frame: 0, x: 0, easing: 'linear'},
			{frame: 1, x: 1, easing: 'linear'},
			{frame: 2, x: 2, easing: 'linear'},
		];
		const repeated = imageItem({
			id: 'repeat',
			motion: {
				transform: {
					keyframes,
					loop: 'repeat',
					loopStartFrame: 0,
					loopEndFrame: 2,
				},
			},
		});
		const pingPong = imageItem({
			id: 'ping-pong',
			motion: {
				transform: {
					keyframes,
					loop: 'ping-pong',
					loopStartFrame: 0,
					loopEndFrame: 2,
				},
			},
		});

		expect(
			[0, 1, 2, 3, 4, 5].map((frame) => poseOf(repeated, frame).left),
		).toEqual([0, 1, 2, 0, 1, 2]);
		expect(
			[0, 1, 2, 3, 4].map((frame) => poseOf(pingPong, frame).left),
		).toEqual([0, 1, 2, 1, 0]);
	});

	it('scales around the item anchor', () => {
		const item = imageItem({
			id: 'anchor',
			left: 100,
			top: 200,
			width: 200,
			height: 400,
			motion: {
				transform: {
					anchorX: 0.5,
					anchorY: 0.5,
					keyframes: [{frame: 0, scaleX: 2, scaleY: 2}],
				},
			},
		});

		expect(poseOf(item, 0)).toMatchObject({
			left: 0,
			top: 0,
			width: 400,
			height: 800,
			anchorX: 0.5,
			anchorY: 0.5,
		});
	});

	it('stacks camera focal motion on top of the item transform', () => {
		const item = imageItem({
			id: 'stacked',
			left: 100,
			top: 100,
			width: 100,
			height: 100,
			motion: {
				transform: {
					anchorX: 0.5,
					anchorY: 0.5,
					keyframes: [{frame: 0, scaleX: 2, scaleY: 2}],
				},
			},
		});
		const cameraShot = shot({
			id: 'camera',
			from: 0,
			cameraMotion: {
				focalX: 0,
				focalY: 0,
				keyframes: [{frame: 0, x: 5, y: -3, scale: 2, easing: 'linear'}],
			},
		});

		expect(poseOf(item, 0, {shot: cameraShot})).toMatchObject({
			left: 105,
			top: 97,
			width: 400,
			height: 400,
		});
	});

	it('switches sprite assets on the keyframe and holds the previous asset', () => {
		const item = imageItem({
			id: 'sprite',
			assetId: 'base',
			motion: {
				spriteStates: [
					{frame: 5, assetId: 'open'},
					{frame: 10, assetId: 'closed'},
					{frame: 12, assetId: 'open'},
				],
			},
		});

		expect(poseOf(item, 4).assetId).toBe('base');
		expect(poseOf(item, 5).assetId).toBe('open');
		expect(poseOf(item, 11).assetId).toBe('closed');
		expect(poseOf(item, 12).assetId).toBe('open');
		expect(poseOf(item, 40).assetId).toBe('open');
	});

	it('fades the outgoing and incoming shots across a crossfade', () => {
		const outgoing = shot({
			id: 'shot-a',
			from: 0,
			durationInFrames: 20,
			transitionOut: {type: 'crossfade', durationInFrames: 10},
		});
		const incoming = shot({
			id: 'shot-b',
			from: 10,
			durationInFrames: 20,
		});
		const panel = imageItem({id: 'panel', opacity: 1});

		expect(poseOf(panel, 9, {shot: outgoing}).opacity).toBe(1);
		expect(poseOf(panel, 15, {shot: outgoing}).opacity).toBeCloseTo(0.5);
		expect(poseOf(panel, 20, {shot: outgoing}).opacity).toBe(0);

		expect(
			poseOf(panel, 10, {shot: incoming, previousShot: outgoing}).opacity,
		).toBe(0);
		expect(
			poseOf(panel, 15, {shot: incoming, previousShot: outgoing}).opacity,
		).toBeCloseTo(0.5);
		expect(
			poseOf(panel, 20, {shot: incoming, previousShot: outgoing}).opacity,
		).toBe(1);
	});

	it('does not modify the item, keyframes, or shot', () => {
		const keyframes: TransformKeyframe[] = [
			{frame: 20, x: 8, easing: 'linear'},
			{frame: 0, x: 0, easing: 'linear'},
		];
		const item = imageItem({
			id: 'frozen',
			motion: {
				transform: {keyframes},
				spriteStates: [
					{frame: 4, assetId: 'closed'},
					{frame: 0, assetId: 'open'},
				],
			},
		});
		const cameraShot = shot({
			id: 'camera',
			from: 0,
			transitionOut: {type: 'crossfade', durationInFrames: 4},
			cameraMotion: {
				keyframes: [
					{frame: 8, scale: 1.1},
					{frame: 0, scale: 1},
				],
			},
		});
		const beforeItem = structuredClone(item);
		const beforeShot = structuredClone(cameraShot);

		poseOf(item, 3, {shot: cameraShot});

		expect(item).toEqual(beforeItem);
		expect(cameraShot).toEqual(beforeShot);
		expect(item.motion?.transform?.keyframes).toBe(keyframes);
		expect(keyframes.map((keyframe) => keyframe.frame)).toEqual([20, 0]);
	});
});

describe('evaluateTransformAtFrame', () => {
	it('evaluates every static transform property with safe defaults', () => {
		expect(
			evaluateTransformAtFrame(
				{
					keyframes: [],
					anchorX: 0.25,
					anchorY: 0.75,
					x: 12,
					y: -8,
					scaleX: 1.5,
					scaleY: 0.5,
					rotation: 30,
					opacity: 0.4,
				},
				5,
			),
		).toEqual({
			anchorX: 0.25,
			anchorY: 0.75,
			x: 12,
			y: -8,
			scaleX: 1.5,
			scaleY: 0.5,
			rotation: 30,
			opacity: 0.4,
		});

		const unsafe = evaluateTransformAtFrame(
			{
				keyframes: [
					{frame: 0, x: Number.NaN, opacity: Number.POSITIVE_INFINITY},
				],
				x: Number.NaN,
				scaleX: Number.NEGATIVE_INFINITY,
			},
			0,
		);
		expect(unsafe).toEqual({
			anchorX: 0.5,
			anchorY: 0.5,
			x: 0,
			y: 0,
			scaleX: 1,
			scaleY: 1,
			rotation: 0,
			opacity: 1,
		});
		expect(Object.values(unsafe).every(Number.isFinite)).toBe(true);
	});

	it('interpolates multiple sparse properties with easing and hold', () => {
		const animation = {
			keyframes: [
				{
					frame: 0,
					x: 0,
					y: 10,
					scaleX: 1,
					rotation: 5,
					opacity: 0.2,
					anchorX: 0,
				},
				{frame: 10, opacity: 0.8, anchorY: 1, hold: true},
				{
					frame: 20,
					x: 100,
					y: 30,
					scaleX: 2,
					rotation: 45,
					opacity: 1,
					anchorX: 1,
					anchorY: 0,
					easing: 'ease-in' as const,
				},
			],
		};
		const atTen = evaluateTransformAtFrame(animation, 10);
		expect(atTen.x).toBeCloseTo(12.5);
		expect(atTen.y).toBeCloseTo(12.5);
		expect(atTen.scaleX).toBeCloseTo(1.125);
		expect(atTen.rotation).toBeCloseTo(10);
		expect(atTen.opacity).toBe(0.8);
		expect(atTen.anchorX).toBeCloseTo(0.125);
		expect(atTen.anchorY).toBe(1);
		expect(evaluateTransformAtFrame(animation, 15).opacity).toBe(0.8);
		expect(evaluateTransformAtFrame(animation, 20).opacity).toBe(1);
	});

	it('clamps evaluation to the item frame range', () => {
		const animation = {
			keyframes: [
				{frame: 0, x: 5},
				{frame: 9, x: 95},
			],
		};
		expect(
			evaluateTransformAtFrame(animation, -100, {durationInFrames: 10}).x,
		).toBe(5);
		expect(
			evaluateTransformAtFrame(animation, 100, {durationInFrames: 10}).x,
		).toBe(95);
	});

	it('returns identical cached and uncached results and invalidates mutations', () => {
		const animation = {
			keyframes: [
				{frame: 0, x: 0},
				{frame: 10, x: 100},
			],
		};
		clearTransformEvaluationCache();
		const uncached = evaluateTransformAtFrame(animation, 5);
		const cached = evaluateTransformAtFrame(animation, 5);
		expect(cached).toEqual(uncached);
		expect(cached).not.toBe(uncached);

		animation.keyframes[1]!.x = 200;
		expect(evaluateTransformAtFrame(animation, 5).x).toBe(100);
		expect(evaluateTransformAtFrame(animation, 6).x).toBe(120);
	});

	it('survives save and reload without changing evaluation', () => {
		const animation: TransformAnimation = {
			animatedProperties: ['position', 'opacity'],
			x: 3,
			y: 4,
			keyframes: [
				{frame: 0, x: 10, opacity: 0.25},
				{frame: 10, x: 30, opacity: 1, easing: 'ease-out' as const},
			],
		};
		const before = evaluateTransformAtFrame(animation, 4);
		const reloaded = JSON.parse(JSON.stringify(animation));
		expect(evaluateTransformAtFrame(reloaded, 4)).toEqual(before);
	});
});

describe('comic project v2 fixture', () => {
	const shots = comicProjectV2.shots ?? [];
	const shotA = shots[0];
	const shotB = shots[1];

	const imageById = (id: string): ImageItem => {
		const item = comicProjectV2.items[id];
		if (!item || item.type !== 'image') {
			throw new Error(`missing image ${id}`);
		}
		return item;
	};

	const poseAt = (id: string, globalFrame: number) => {
		const item = imageById(id);
		const itemShot =
			shots.find((candidate) => candidate.id === item.shotId) ?? null;
		return evaluateImagePose({
			item,
			shot: itemShot,
			previousShot: findPreviousCrossfadeShot(shots, itemShot),
			globalFrame,
			compositionWidth: comicProjectV2.compositionWidth,
			compositionHeight: comicProjectV2.compositionHeight,
			fadeOpacity: 1,
		});
	};

	it('finds the crossfade source for the second shot', () => {
		expect(findPreviousCrossfadeShot(shots, shotB)).toBe(shotA);
		expect(findPreviousCrossfadeShot(shots, shotA)).toBeNull();
	});

	it('matches the first, middle, and last frames of camera, breathing, sprite, and crossfade', () => {
		const background = imageById('item-shot-a-background');
		expect(poseAt(background.id, 0)).toMatchObject({
			assetId: 'asset-background',
			left: 0,
			top: 0,
			width: 1080,
			height: 1920,
			rotation: 0,
			opacity: 1,
		});

		const middleScale = 1 + (1.08 - 1) * applyEasing('ease-in-out', 60 / 119);
		const middle = poseAt(background.id, 60);
		expect(middle.left).toBeCloseTo(540 + (0 - 540) * middleScale);
		expect(middle.top).toBeCloseTo(960 + (0 - 960) * middleScale);
		expect(middle.width).toBeCloseTo(1080 * middleScale);
		expect(middle.height).toBeCloseTo(1920 * middleScale);
		expect(middle.opacity).toBe(1);
		expect(poseAt(background.id, 104).opacity).toBe(1);
		expect(poseAt(background.id, 112.5).opacity).toBeCloseTo(0.5);
		const end = poseAt(background.id, 119);
		expect(end.left).toBeCloseTo(540 + (0 - 540) * 1.08);
		expect(end.top).toBeCloseTo(960 + (0 - 960) * 1.08);
		expect(end.width).toBeCloseTo(1080 * 1.08);
		expect(end.height).toBeCloseTo(1920 * 1.08);
		expect(poseAt(background.id, 119).opacity).toBeCloseTo(1 / 15);
		expect(poseAt(background.id, 120).opacity).toBe(0);

		const character = imageById('item-shot-a-character');
		expect(poseAt(character.id, 0)).toMatchObject({
			left: character.left,
			top: character.top,
			width: character.width,
			height: character.height,
			opacity: 1,
		});
		const characterScale =
			1 + (1.08 - 1) * applyEasing('ease-in-out', 45 / 119);
		const breathedLeft = 180 + 720 * 0.5 * (1 - 1.02);
		const breathedTop = 360 + 1400 * 0.5 * (1 - 1.02);
		const breathed = poseAt(character.id, 45);
		expect(breathed.left).toBeCloseTo(
			540 + (breathedLeft - 540) * characterScale,
		);
		expect(breathed.top).toBeCloseTo(
			960 + (breathedTop - 960) * characterScale,
		);
		expect(breathed.width).toBeCloseTo(720 * 1.02 * characterScale);
		expect(breathed.height).toBeCloseTo(1400 * 1.02 * characterScale);

		expect(poseAt('item-shot-a-eye', 0).assetId).toBe('asset-eye-open');
		expect(poseAt('item-shot-a-eye', 39).assetId).toBe('asset-eye-open');
		expect(poseAt('item-shot-a-eye', 40).assetId).toBe('asset-eye-closed');
		expect(poseAt('item-shot-a-eye', 45).assetId).toBe('asset-eye-closed');
		expect(poseAt('item-shot-a-eye', 46).assetId).toBe('asset-eye-open');

		const incoming = imageById('item-shot-b-panel');
		expect(poseAt(incoming.id, 105)).toMatchObject({
			left: 0,
			top: 0,
			width: 1080,
			height: 1920,
			opacity: 0,
		});
		expect(poseAt(incoming.id, 112.5).opacity).toBeCloseTo(0.5);
		expect(poseAt(incoming.id, 120).opacity).toBe(1);
	});
});
