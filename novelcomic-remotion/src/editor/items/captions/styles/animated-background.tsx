import React, {useMemo} from 'react';
import {
	AbsoluteFill,
	interpolate,
	spring,
	useCurrentFrame,
	useVideoConfig,
} from 'remotion';
import {turnFontStyleIntoCss} from '../../../inspector/controls/font-style-controls/font-style-controls';
import {CaptionPageProps} from '../caption-page';
import {
	getCaptionFontSize,
	getCaptionFrameStyle,
	getMeasuredCaptionText,
} from './shared';

const ANIMATION_LENGTH = 5;
const HORIZONTAL_PADDING = 12;
const VERTICAL_PADDING = 12;

const tokenStyle: React.CSSProperties = {
	whiteSpace: 'pre',
	position: 'relative',
};

export const AnimatedBackgroundPage: React.FC<CaptionPageProps> = (props) => {
	const {fps} = useVideoConfig();
	const frame = useCurrentFrame();

	const fontSize = useMemo(() => {
		return getCaptionFontSize(props);
	}, [props]);

	const frameStyle = useMemo(() => {
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

	const additionalStyles = useMemo(() => {
		return Object.fromEntries(
			Object.entries(turnFontStyleIntoCss(props.fontStyle)).map(
				([key, value]) => [key, String(value)],
			),
		);
	}, [props.fontStyle]);

	const backgroundWidths = useMemo(() => {
		return props.page.tokens.map((token) => {
			const withWhitespace = getMeasuredCaptionText({
				fontFamily: props.fontFamily,
				fontSize,
				text: token.text,
				fontWeight: props.fontStyle.weight,
				letterSpacing: props.letterSpacing,
				additionalStyles,
			});
			const withoutWhitespace = getMeasuredCaptionText({
				fontFamily: props.fontFamily,
				fontSize,
				text: token.text.trim(),
				fontWeight: props.fontStyle.weight,
				letterSpacing: props.letterSpacing,
				additionalStyles,
			});

			return {
				withWhitespace,
				withoutWhitespace,
				from: token.fromMs - props.page.startMs,
			};
		});
	}, [
		additionalStyles,
		fontSize,
		props.fontFamily,
		props.fontStyle.weight,
		props.letterSpacing,
		props.page.startMs,
		props.page.tokens,
	]);

	const wordIndex = backgroundWidths.reduce((sum, token, i) => {
		const nextWord = backgroundWidths[i + 1];
		if (!nextWord) {
			return sum;
		}

		const animate = spring({
			durationInFrames: ANIMATION_LENGTH,
			config: {
				damping: 100,
			},
			fps,
			frame,
			delay: (nextWord.from / 1000) * fps - ANIMATION_LENGTH / 2,
		});

		return sum + animate;
	}, 0);

	const offsetLeft = backgroundWidths.reduce((sum, token, i) => {
		const nextToken = backgroundWidths[i + 1] ?? null;
		const nextTokenWhitespace =
			nextToken === null
				? 0
				: nextToken.withWhitespace.width - nextToken.withoutWhitespace.width;
		const widthToAdd = token.withoutWhitespace.width + nextTokenWhitespace;

		if (i > wordIndex) {
			return sum;
		}

		if (i <= wordIndex - 1) {
			return sum + widthToAdd;
		}

		return sum + (wordIndex % 1) * widthToAdd;
	}, 0);

	const width =
		backgroundWidths.length === 0
			? 0
			: backgroundWidths.length === 1
				? backgroundWidths[0].withoutWhitespace.width
				: interpolate(
						wordIndex,
						new Array(backgroundWidths.length).fill(1).map((_, i) => i),
						backgroundWidths.map((w) => w.withoutWhitespace.width),
					);

	const totalWidth = backgroundWidths.reduce((sum, token) => {
		return sum + token.withWhitespace.width;
	}, 0);
	const maxBackgroundWidth = backgroundWidths.reduce((max, token) => {
		return Math.max(max, token.withoutWhitespace.width);
	}, 0);

	const appear = interpolate(
		spring({
			fps,
			frame,
			config: {
				damping: 200,
			},
			durationInFrames: ANIMATION_LENGTH,
		}),
		[0, 1],
		[0.6, 1],
	);

	const outerStyle: React.CSSProperties = useMemo(() => {
		return {
			position: 'relative',
			width: Math.ceil(totalWidth),
			maxWidth: '100%',
		};
	}, [totalWidth]);

	const backgroundStyle: React.CSSProperties = useMemo(() => {
		if (backgroundWidths.length === 0) {
			return {
				display: 'none',
			};
		}

		return {
			height: fontSize + VERTICAL_PADDING * 2,
			backgroundColor: props.highlightColor,
			width: maxBackgroundWidth + HORIZONTAL_PADDING * 2,
			display: 'block',
			position: 'absolute',
			left: 0,
			marginLeft: -HORIZONTAL_PADDING,
			paddingLeft: HORIZONTAL_PADDING,
			paddingRight: HORIZONTAL_PADDING,
			borderRadius: 10,
			marginTop: -VERTICAL_PADDING,
			transform: `translateX(${offsetLeft}px) scale(${appear}) scaleX(${
				(width + HORIZONTAL_PADDING * 2) /
				(maxBackgroundWidth + HORIZONTAL_PADDING * 2)
			})`,
			transformOrigin: 'left center',
			willChange: 'transform',
		};
	}, [
		appear,
		fontSize,
		maxBackgroundWidth,
		offsetLeft,
		props.highlightColor,
		width,
		backgroundWidths.length,
	]);

	return (
		<AbsoluteFill>
			<div style={frameStyle}>
				<div style={outerStyle}>
					<div style={backgroundStyle} />
					{props.page.tokens.map((token, i) => {
						return (
							<span
								key={i}
								style={{
									...tokenStyle,
									color: props.color,
								}}
							>
								{token.text}
							</span>
						);
					})}
				</div>
			</div>
		</AbsoluteFill>
	);
};
