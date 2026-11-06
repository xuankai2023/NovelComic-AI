import {BaseItem, CanHaveRotation} from '../shared';
import {FontStyle, TextAlign, TextDirection} from '../text/text-item-type';

export const CAPTION_STYLE_TYPES = [
	'default',
	'colored-words',
	'scaling-words',
	'animated-background',
] as const;

export type CaptionStyleType = (typeof CAPTION_STYLE_TYPES)[number];

export const DEFAULT_CAPTION_STYLE: CaptionStyleType = 'default';

export const isCaptionStyleType = (
	value: unknown,
): value is CaptionStyleType => {
	return CAPTION_STYLE_TYPES.includes(value as CaptionStyleType);
};

export const normalizeCaptionStyle = (value: unknown): CaptionStyleType => {
	return isCaptionStyleType(value) ? value : DEFAULT_CAPTION_STYLE;
};

export type CaptionsItem = BaseItem &
	CanHaveRotation & {
		type: 'captions';
		assetId: string;
		captionStyle: CaptionStyleType;
		fontFamily: string;
		fontStyle: FontStyle;
		lineHeight: number;
		letterSpacing: number;
		fontSize: number;
		align: TextAlign;
		color: string;
		highlightColor: string;
		strokeWidth: number;
		strokeColor: string;
		direction: TextDirection;
		pageDurationInMilliseconds: number;
		captionStartInSeconds: number;
		maxLines: number;
		fadeInDurationInSeconds: number;
		fadeOutDurationInSeconds: number;
		lineId?: string;
		shotId?: string;
		characterId?: string;
		voiceProfileId?: string;
	};
