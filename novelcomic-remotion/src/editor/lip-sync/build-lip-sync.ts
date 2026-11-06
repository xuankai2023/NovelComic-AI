import type {LipSyncTrack, MouthState} from '../composition/types';

export type PhonemeSpan = {
	phoneme: string;
	startFrame: number;
	endFrame: number;
	confidence?: number;
};

export type VisemeMap = Record<string, string>;

const normalizeRange = (from: number, to: number): {from: number; to: number} => {
	if (!Number.isFinite(from) || !Number.isFinite(to)) {
		throw new Error('Lip-sync frame range must be finite');
	}
	return {from: Math.floor(from), to: Math.ceil(to)};
};

export const buildRuleLipSync = ({
	id,
	mouthLayerId,
	dialogueItemId,
	from,
	to,
	closedAssetId,
	halfAssetId,
	openAssetId,
	maxSwitchesPerSecond = 8,
	fps = 30,
}: {
	id: string;
	mouthLayerId: string;
	dialogueItemId: string;
	from: number;
	to: number;
	closedAssetId: string;
	halfAssetId?: string;
	openAssetId: string;
	maxSwitchesPerSecond?: number;
	fps?: number;
}): LipSyncTrack => {
	const range = normalizeRange(from, to);
	if (range.to <= range.from) {
		throw new Error('Lip-sync range must have a positive duration');
	}

	const step = Math.max(1, Math.round(fps / Math.max(1, maxSwitchesPerSecond)));
	const states: MouthState[] = [];
	for (let frame = range.from; frame < range.to; frame += step) {
		const index = Math.floor((frame - range.from) / step) % (halfAssetId ? 3 : 2);
		const assetId =
			halfAssetId && index === 1
				? halfAssetId
				: index === 0
					? closedAssetId
					: openAssetId;
		states.push({
			from: frame,
			to: Math.min(range.to, frame + step),
			assetId,
			viseme: assetId === closedAssetId ? 'closed' : 'open',
		});
	}

	return {
		id,
		mouthLayerId,
		dialogueItemId,
		mode: 'rule',
		states,
		fallbackState: closedAssetId,
	};
};

export const buildVisemeLipSync = ({
	id,
	mouthLayerId,
	dialogueItemId,
	phonemes,
	visemeMap,
	mouthAssetByViseme,
	fallbackState,
}: {
	id: string;
	mouthLayerId: string;
	dialogueItemId: string;
	phonemes: readonly PhonemeSpan[];
	visemeMap: VisemeMap;
	mouthAssetByViseme: Record<string, string>;
	fallbackState: string;
}): LipSyncTrack => {
	const states = phonemes
		.filter((phoneme) => phoneme.endFrame > phoneme.startFrame)
		.map((phoneme) => {
			const viseme = visemeMap[phoneme.phoneme] ?? 'closed';
			return {
				from: phoneme.startFrame,
				to: phoneme.endFrame,
				assetId: mouthAssetByViseme[viseme] ?? fallbackState,
				viseme,
			};
		});

	return {
		id,
		mouthLayerId,
		dialogueItemId,
		mode: 'phoneme',
		states,
		fallbackState,
	};
};
