import React, {useMemo} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {CaptionPageProps} from '../caption-page';
import {getCaptionFontSize, getCaptionFrameStyle} from './shared';

export const ColoredWordsPage: React.FC<CaptionPageProps> = (props) => {
	const {fps} = useVideoConfig();
	const frame = useCurrentFrame();

	const fontSize = useMemo(() => {
		return getCaptionFontSize(props);
	}, [props]);

	const style = useMemo(() => {
		return getCaptionFrameStyle({
			fontFamily: props.fontFamily,
			fontStyle: props.fontStyle,
			lineHeight: props.lineHeight,
			letterSpacing: props.letterSpacing,
			align: props.align,
			direction: props.direction,
			fontSize,
			color: props.color,
		});
	}, [fontSize, props]);

	return (
		<AbsoluteFill>
			<div style={style}>
				<span>
					{props.page.tokens.map((token, i) => {
						const from = ((token.fromMs - props.page.startMs) / 1000) * fps;
						const end = ((token.toMs - props.page.startMs) / 1000) * fps;
						const active = frame >= from && frame < end;

						return (
							<span
								key={i}
								style={{
									color: active ? props.highlightColor : props.color,
									whiteSpace: 'pre',
								}}
							>
								{token.text}
							</span>
						);
					})}
				</span>
			</div>
		</AbsoluteFill>
	);
};
