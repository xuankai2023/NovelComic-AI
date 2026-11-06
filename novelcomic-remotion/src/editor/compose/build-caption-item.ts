import type {Caption} from '@remotion/captions';
import {CaptionAsset} from '../assets/assets';
import {
	CaptionsItem,
	CaptionStyleType,
	DEFAULT_CAPTION_STYLE,
} from '../items/captions/captions-item-type';
import {generateRandomId} from '../utils/generate-random-id';

const DEFAULT_FONT_SIZE = 80;
const DEFAULT_LINE_HEIGHT = 1.2;
const DEFAULT_MAX_LINES = 2;
const DEFAULT_HIGHLIGHT_COLOR = '#39E508';

export type CaptionPosition = 'top' | 'center' | 'bottom';

export type CaptionAppearanceOptions = {
	color?: string;
	highlightColor?: string;
	strokeColor?: string;
	fontSize?: number;
	strokeWidth?: number;
	maxLines?: number;
	pageDurationInMilliseconds?: number;
	fontFamily?: string;
	fontWeight?: string;
	lineHeight?: number;
	letterSpacing?: number;
};

const EDGE_PADDING_RATIO = 0.05;

const computeCaptionTop = (
	position: CaptionPosition,
	compositionHeight: number,
	captionHeight: number,
): number => {
	switch (position) {
		case 'top':
			return Math.round(compositionHeight * EDGE_PADDING_RATIO);
		case 'center':
			return Math.round((compositionHeight - captionHeight) / 2);
		case 'bottom':
		default:
			return Math.round(
				compositionHeight * (1 - EDGE_PADDING_RATIO) - captionHeight,
			);
	}
};

export const buildCaptionAsset = (captions: Caption[]): CaptionAsset => {
	return {
		id: generateRandomId(),
		type: 'caption',
		captions,
		filename: 'captions.srt',
		remoteUrl: null,
		remoteFileKey: null,
		size: new Blob([JSON.stringify(captions)]).size,
		mimeType: 'application/json',
	};
};

export const buildCaptionsItem = ({
	asset,
	fromFrame,
	fps,
	compositionWidth,
	compositionHeight,
	captionStyle,
	captionStartInSeconds = 0,
	captionPosition = 'bottom',
	captionOptions,
}: {
	asset: CaptionAsset;
	fromFrame: number;
	fps: number;
	compositionWidth: number;
	compositionHeight: number;
	captionStyle?: CaptionStyleType;
	captionStartInSeconds?: number;
	captionPosition?: CaptionPosition;
	captionOptions?: CaptionAppearanceOptions;
}): CaptionsItem => {
	const lastCaption = asset.captions[asset.captions.length - 1];
	const captionDurationSec = lastCaption
		? lastCaption.endMs / 1000 - captionStartInSeconds
		: 0;

	const fontSize = captionOptions?.fontSize ?? DEFAULT_FONT_SIZE;
	const maxLines = captionOptions?.maxLines ?? DEFAULT_MAX_LINES;
	const lineHeight = captionOptions?.lineHeight ?? DEFAULT_LINE_HEIGHT;
	const width = Math.round(compositionWidth * 0.9);
	const captionHeight = fontSize * lineHeight * maxLines;

	return {
		id: generateRandomId(),
		type: 'captions',
		assetId: asset.id,
		captionStyle: captionStyle ?? DEFAULT_CAPTION_STYLE,
		durationInFrames: Math.round(captionDurationSec * fps),
		from: fromFrame,
		width,
		height: captionHeight,
		top: computeCaptionTop(captionPosition, compositionHeight, captionHeight),
		left: Math.round((compositionWidth - width) / 2),
		opacity: 1,
		rotation: 0,
		fontFamily: captionOptions?.fontFamily ?? 'TikTok Sans',
		fontStyle: {
			variant: 'normal',
			weight: captionOptions?.fontWeight ?? '600',
		},
		lineHeight,
		letterSpacing: captionOptions?.letterSpacing ?? 0,
		fontSize,
		align: 'center',
		color: captionOptions?.color ?? 'white',
		highlightColor: captionOptions?.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR,
		strokeWidth: captionOptions?.strokeWidth ?? 4,
		strokeColor: captionOptions?.strokeColor ?? 'black',
		direction: 'ltr',
		pageDurationInMilliseconds:
			captionOptions?.pageDurationInMilliseconds ?? 2000,
		captionStartInSeconds,
		maxLines,
		fadeInDurationInSeconds: 0,
		fadeOutDurationInSeconds: 0,
		isDraggingInTimeline: false,
	};
};
