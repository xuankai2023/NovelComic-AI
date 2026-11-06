import {describe, expect, it} from 'vitest';
import type {SpriteState} from '../motion/types';
import {
	MAX_SPRITE_SWITCHES_PER_SECOND,
	buildBlinkSpriteStates,
	buildMouthFlapSpriteStates,
} from './build-sprite-motion';

const maxSwitchesInOneSecond = (
	states: readonly SpriteState[],
	fps: number,
	durationInFrames: number,
): number => {
	const changes = states.slice(1).map((state) => state.frame);
	let max = 0;
	for (let start = 0; start < durationInFrames; start++) {
		const count = changes.filter((frame) => {
			return frame >= start && frame < start + fps;
		}).length;
		max = Math.max(max, count);
	}

	return max;
};

describe('build sprite motion', () => {
	it('rejects missing blink or mouth assets', () => {
		expect(() => {
			buildBlinkSpriteStates({
				openAssetId: 'open',
				closedAssetId: '',
				seed: 1,
				durationInFrames: 60,
			});
		}).toThrow(/open and closed assets/);
		expect(() => {
			buildMouthFlapSpriteStates({
				assetIds: {closed: 'closed', open: ' '},
				dialogueRanges: [],
				durationInFrames: 30,
			});
		}).toThrow(/closed and open assets/);
	});

	it('is deterministic for a seed and stays inside the switch limit', () => {
		const input = {
			openAssetId: 'open',
			closedAssetId: 'closed',
			seed: 1,
			durationInFrames: 180,
			fps: 30,
		};
		const first = buildBlinkSpriteStates(input);
		const second = buildBlinkSpriteStates(input);
		const other = buildBlinkSpriteStates({...input, seed: 2});

		expect(first).toEqual(second);
		expect(first).not.toEqual(other);
		expect(first.some((state) => state.assetId === 'closed')).toBe(true);
		expect(
			maxSwitchesInOneSecond(first, 30, input.durationInFrames),
		).toBeLessThanOrEqual(MAX_SPRITE_SWITCHES_PER_SECOND);
		expect(
			maxSwitchesInOneSecond(other, 30, input.durationInFrames),
		).toBeLessThanOrEqual(MAX_SPRITE_SWITCHES_PER_SECOND);
	});

	it('keeps mouth flaps inside dialogue and under the switch limit', () => {
		const durationInFrames = 90;
		const fps = 30;
		expect(() => {
			buildMouthFlapSpriteStates({
				assetIds: {closed: 'closed', half: 'half', open: 'open'},
				dialogueRanges: [{from: 0, durationInFrames: durationInFrames + 1}],
				durationInFrames,
				fps,
			});
		}).toThrow(/outside the item/);
		expect(() => {
			buildMouthFlapSpriteStates({
				assetIds: {closed: 'closed', open: 'open'},
				dialogueRanges: [{from: -1, durationInFrames: 4}],
				durationInFrames,
				fps,
			});
		}).toThrow(/outside the item/);

		const states = buildMouthFlapSpriteStates({
			assetIds: {closed: 'closed', half: 'half', open: 'open'},
			dialogueRanges: [{from: 10, durationInFrames: 20}],
			durationInFrames,
			fps,
		});
		const full = buildMouthFlapSpriteStates({
			assetIds: {closed: 'closed', half: 'half', open: 'open'},
			dialogueRanges: [{from: 0, durationInFrames}],
			durationInFrames,
			fps,
		});

		expect(states[0]).toEqual({frame: 0, assetId: 'closed'});
		expect(states.some((state) => state.frame >= 10 && state.frame < 30)).toBe(
			true,
		);
		expect(
			states.filter((state) => state.frame > 0 && state.frame < 10),
		).toEqual([]);
		expect(states.every((state) => state.frame < durationInFrames)).toBe(true);
		expect(full.some((state) => state.assetId === 'open')).toBe(true);
		expect(
			maxSwitchesInOneSecond(full, fps, durationInFrames),
		).toBeLessThanOrEqual(MAX_SPRITE_SWITCHES_PER_SECOND);
		expect(
			buildMouthFlapSpriteStates({
				assetIds: {closed: 'closed', half: 'half', open: 'open'},
				dialogueRanges: [{from: 10, durationInFrames: 20}],
				durationInFrames,
				fps,
			}),
		).toEqual(states);
	});

	it('uses phoneme cues for mouth flaps when they are provided', () => {
		const states = buildMouthFlapSpriteStates({
			assetIds: {closed: 'closed', half: 'half', open: 'open'},
			dialogueRanges: [{from: 0, durationInFrames: 40}],
			phonemeCues: [
				{from: 5, durationInFrames: 4, phoneme: 'M'},
				{from: 9, durationInFrames: 6, phoneme: 'AA'},
				{from: 22, durationInFrames: 5, mouthShape: 'closed'},
				{from: 30, durationInFrames: 5, mouthShape: 'open'},
			],
			durationInFrames: 60,
			fps: 30,
		});

		expect(states).toEqual([
			{frame: 0, assetId: 'closed'},
			{frame: 5, assetId: 'half'},
			{frame: 9, assetId: 'open'},
			{frame: 15, assetId: 'closed'},
			{frame: 30, assetId: 'open'},
			{frame: 35, assetId: 'closed'},
		]);
		expect(() => {
			buildMouthFlapSpriteStates({
				assetIds: {closed: 'closed', half: 'half', open: 'open'},
				dialogueRanges: [],
				phonemeCues: [
					{from: 5, durationInFrames: 4, phoneme: 'M'},
					{from: 8, durationInFrames: 4, phoneme: 'AA'},
				],
				durationInFrames: 60,
			});
		}).toThrow(/overlap/);
	});
});
