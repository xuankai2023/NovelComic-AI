import React, {useMemo} from 'react';
import {AbsoluteFill, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {CaptionPageProps} from '../caption-page';
import {getCaptionFontSize, getCaptionFrameStyle} from './shared';

export const ScalingWordsPage: React.FC<CaptionPageProps> = (props) => {
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
						const animation = active
							? spring({
									fps,
									frame,
									delay: from,
									durationInFrames: Math.min(4, end - from),
								})
							: 0;
						const scale = animation * 0.2 + 1;

						return (
							<span
								key={i}
								style={{
									color: active ? props.highlightColor : props.color,
									whiteSpace: 'pre',
									fontSize,
									display: 'inline-block',
									verticalAlign: 'middle',
									transform: `perspective(100px) scale(${scale})`,
									transformOrigin: 'center',
									willChange: 'transform',
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
