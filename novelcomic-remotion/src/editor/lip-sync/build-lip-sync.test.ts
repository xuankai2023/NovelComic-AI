import {describe, expect, it} from 'vitest';
import {buildRuleLipSync, buildVisemeLipSync} from './build-lip-sync';

describe('lip-sync builders', () => {
	it('builds deterministic rule mouth states within dialogue range', () => {
		const track = buildRuleLipSync({
			id: 'lip-1',
			mouthLayerId: 'mouth',
			dialogueItemId: 'dialogue',
			from: 10,
			to: 40,
			closedAssetId: 'closed',
			halfAssetId: 'half',
			openAssetId: 'open',
			fps: 30,
			maxSwitchesPerSecond: 6,
		});

		expect(track.mode).toBe('rule');
		expect(track.states[0]).toMatchObject({from: 10, assetId: 'closed'});
		expect(track.states.at(-1)?.to).toBe(40);
		expect(track.states.every((state) => state.from >= 10 && state.to <= 40)).toBe(
			true,
		);
	});

	it('maps phonemes to visemes and falls back for missing assets', () => {
		const track = buildVisemeLipSync({
			id: 'lip-2',
			mouthLayerId: 'mouth',
			dialogueItemId: 'dialogue',
			phonemes: [
				{phoneme: 'AA', startFrame: 0, endFrame: 3},
				{phoneme: 'M', startFrame: 3, endFrame: 5},
			],
			visemeMap: {AA: 'open', M: 'closed'},
			mouthAssetByViseme: {open: 'open'},
			fallbackState: 'closed',
		});

		expect(track.mode).toBe('phoneme');
		expect(track.states).toEqual([
			{from: 0, to: 3, assetId: 'open', viseme: 'open'},
			{from: 3, to: 5, assetId: 'closed', viseme: 'closed'},
		]);
	});
});
