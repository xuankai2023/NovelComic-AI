import {TikTokPage} from '@remotion/captions';
import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {turnFontStyleIntoCss} from '../../inspector/controls/font-style-controls/font-style-controls';
import {FontStyle, TextAlign, TextDirection} from '../text/text-item-type';
import {getCaptionNLineFontSize} from './styles/shared';

export type CaptionPageProps = {
	page: TikTokPage;
	captionWidth: number;
	fontFamily: string;
	fontStyle: FontStyle;
	lineHeight: number;
	letterSpacing: number;
	color: string;
	highlightColor: string;
	direction: TextDirection;
	align: TextAlign;
	fontSize: number;
	maxLines: number;
};

export const CaptionPage: React.FC<CaptionPageProps> = ({
	page,
	captionWidth,
	fontFamily,
	fontStyle,
	lineHeight,
	letterSpacing,
	color,
	highlightColor,
	direction,
	align,
	fontSize: desiredFontSize,
	maxLines,
}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const timeInMs = (frame / fps) * 1000;

	const fontSize = React.useMemo(() => {
		return getCaptionNLineFontSize({
			page,
			captionWidth,
			fontFamily,
			fontSize: desiredFontSize,
			maxLines,
		});
	}, [captionWidth, desiredFontSize, fontFamily, maxLines, page]);

	const style: React.CSSProperties = React.useMemo(
		() => ({
			fontSize: fontSize,
			color: 'white',
			fontFamily,
			height: '100%',
			width: '100%',
			...turnFontStyleIntoCss(fontStyle),
			lineHeight: String(lineHeight),
			letterSpacing: `${letterSpacing}px`,
			textAlign: align,
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
		}),
		[fontSize, fontFamily, fontStyle, lineHeight, letterSpacing, align],
	);

	return (
		<AbsoluteFill>
			<div dir={direction} style={style}>
				<span>
					{page.tokens.map((t) => {
						const startRelativeToSequence = t.fromMs - page.startMs;
						const endRelativeToSequence = t.toMs - page.startMs;

						const active =
							startRelativeToSequence <= timeInMs &&
							endRelativeToSequence > timeInMs;

						return (
							<span
								key={t.fromMs + t.text}
								style={{
									display: 'inline',
									whiteSpace: 'pre-wrap',
									color: active ? highlightColor : color,
								}}
							>
								{t.text}
							</span>
						);
					})}
				</span>
			</div>
		</AbsoluteFill>
	);
};
