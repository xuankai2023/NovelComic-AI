import {BaseItem} from '../shared';

export type AudioItem = BaseItem & {
	type: 'audio';
	audioStartFromInSeconds: number;
	decibelAdjustment: number;
	playbackRate: number;
	audioFadeInDurationInSeconds: number;
	audioFadeOutDurationInSeconds: number;
	assetId: string;
	lineId?: string;
	shotId?: string;
	characterId?: string;
	voiceProfileId?: string;
	voiceProvider?: string;
	voiceId?: string;
	voiceStyle?: string;
};
