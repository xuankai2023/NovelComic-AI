import {fitText, fitTextOnNLines, measureText} from '@remotion/layout-utils';
import React from 'react';
import {turnFontStyleIntoCss} from '../../../inspector/controls/font-style-controls/font-style-controls';
import {CaptionPageProps} from '../caption-page';

const MAX_TEXT_MEASURE_CACHE_SIZE = 500;

const captionFontSizeCache = new Map<string, number>();
const captionNLineFontSizeCache = new Map<string, number>();
const measuredTextCache = new Map<string, ReturnType<typeof measureText>>();

const remember = <Value>(
	cache: Map<string, Value>,
	key: string,
	value: Value,
) => {
	if (cache.size >= MAX_TEXT_MEASURE_CACHE_SIZE) {
		cache.delete(cache.keys().next().value as string);
	}

	cache.set(key, value);
	return value;
};

const getFontStyleCacheKey = (fontStyle: CaptionPageProps['fontStyle']) => {
	return `${fontStyle.variant}:${fontStyle.weight}`;
};

export const getCaptionFontSize = ({
	page,
	captionWidth,
	fontFamily,
	fontStyle,
	fontSize,
	letterSpacing,
}: Pick<
	CaptionPageProps,
	| 'page'
	| 'captionWidth'
	| 'fontFamily'
	| 'fontStyle'
	| 'fontSize'
	| 'letterSpacing'
>) => {
	const cacheKey = [
		page.text,
		captionWidth,
		fontFamily,
		getFontStyleCacheKey(fontStyle),
		fontSize,
		letterSpacing,
	].join('|');
	const cached = captionFontSizeCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	const fittedText = fitText({
		fontFamily,
		text: page.text,
		withinWidth: captionWidth,
		fontWeight: fontStyle.weight,
		letterSpacing: `${letterSpacing}px`,
		validateFontIsLoaded: false,
		additionalStyles: Object.fromEntries(
			Object.entries(turnFontStyleIntoCss(fontStyle)).map(([key, value]) => [
				key,
				String(value),
			]),
		),
	});

	return remember(
		captionFontSizeCache,
		cacheKey,
		Math.min(fontSize, fittedText.fontSize),
	);
};

export const getCaptionNLineFontSize = ({
	page,
	captionWidth,
	fontFamily,
	fontSize,
	maxLines,
}: Pick<
	CaptionPageProps,
	'page' | 'captionWidth' | 'fontFamily' | 'fontSize' | 'maxLines'
>) => {
	const cacheKey = [
		page.text,
		captionWidth,
		fontFamily,
		fontSize,
		maxLines,
	].join('|');
	const cached = captionNLineFontSizeCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	const fittedText = fitTextOnNLines({
		fontFamily,
		text: page.text,
		maxBoxWidth: captionWidth,
		maxLines,
		maxFontSize: fontSize,
	});

	return remember(
		captionNLineFontSizeCache,
		cacheKey,
		Math.min(fontSize, fittedText.fontSize),
	);
};

export const getMeasuredCaptionText = ({
	fontFamily,
	fontSize,
	text,
	fontWeight,
	letterSpacing,
	additionalStyles,
}: {
	fontFamily: string;
	fontSize: number;
	text: string;
	fontWeight: string;
	letterSpacing: number;
	additionalStyles: Record<string, string>;
}) => {
	const cacheKey = [
		fontFamily,
		fontSize,
		text,
		fontWeight,
		letterSpacing,
		JSON.stringify(additionalStyles),
	].join('|');
	const cached = measuredTextCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	return remember(
		measuredTextCache,
		cacheKey,
		measureText({
			fontFamily,
			fontSize,
			text,
			fontWeight,
			letterSpacing: `${letterSpacing}px`,
			validateFontIsLoaded: false,
			additionalStyles,
		}),
	);
};

export const getCaptionFrameStyle = ({
	fontFamily,
	fontStyle,
	lineHeight,
	letterSpacing,
	align,
	direction,
	fontSize,
	color,
}: Pick<
	CaptionPageProps,
	| 'fontFamily'
	| 'fontStyle'
	| 'lineHeight'
	| 'letterSpacing'
	| 'align'
	| 'direction'
	| 'color'
> & {fontSize: number}): React.CSSProperties => {
	return {
		fontSize,
		color,
		fontFamily,
		height: '100%',
		width: '100%',
		...turnFontStyleIntoCss(fontStyle),
		lineHeight: String(lineHeight),
		letterSpacing: `${letterSpacing}px`,
		textAlign: align,
		direction,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	};
};
