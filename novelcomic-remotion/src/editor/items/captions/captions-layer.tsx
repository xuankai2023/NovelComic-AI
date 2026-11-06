import {createTikTokStyleCaptions} from '@remotion/captions';
import React, {useContext, useMemo} from 'react';
import {Sequence, useCurrentFrame, useVideoConfig} from 'remotion';
import {CaptionAsset} from '../../assets/assets';
import {TextItemHoverPreviewContext} from '../../context-provider';
import {FontInfoContext} from '../../utils/text/font-info';
import {useLoadFontFromTextItem} from '../../utils/text/load-font-from-text-item';
import {useAssetFromAssetId} from '../../utils/use-context';
import {EditorStarterItem} from '../item-type';
import {
	calculateFadeInOpacity,
	calculateFadeOutOpacity,
} from '../video/calculate-fade';
import {CaptionPage} from './caption-page';
import {normalizeCaptionStyle} from './captions-item-type';
import {overrideCaptionsItemWithHoverPreview} from './override-captions-item-with-hover-preview';
import {AnimatedBackgroundPage} from './styles/animated-background';
import {ColoredWordsPage} from './styles/colored-words';
import {ScalingWordsPage} from './styles/scaling-words';

const SWITCH_CAPTIONS_EVERY_MS = 1200;

export const CaptionsLayer = ({
	item: itemWithoutHoverPreview,
}: {
	item: EditorStarterItem;
}) => {
	if (itemWithoutHoverPreview.type !== 'captions') {
		throw new Error('Item is not captions');
	}

	const textItemHoverPreview = useContext(TextItemHoverPreviewContext);
	const item = useMemo(() => {
		return overrideCaptionsItemWithHoverPreview(
			itemWithoutHoverPreview,
			textItemHoverPreview,
		);
	}, [itemWithoutHoverPreview, textItemHoverPreview]);

	const captionAsset = useAssetFromAssetId(item.assetId) as CaptionAsset;
	const context = useContext(FontInfoContext);

	const loaded = useLoadFontFromTextItem({
		fontFamily: item.fontFamily,
		fontVariant: item.fontStyle.variant,
		fontWeight: item.fontStyle.weight,
		fontInfosDuringRendering: context[item.fontFamily] ?? null,
	});

	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();

	const opacity = useMemo(() => {
		const inOpacity = calculateFadeInOpacity({
			currentFrame: frame,
			fadeInDurationInSeconds: item.fadeInDurationInSeconds,
			framesPerSecond: fps,
		});
		const outOpacity = calculateFadeOutOpacity({
			currentFrame: frame,
			fadeOutDurationInSeconds: item.fadeOutDurationInSeconds,
			framesPerSecond: fps,
			totalDurationInFrames: item.durationInFrames,
		});
		return inOpacity * outOpacity * item.opacity;
	}, [
		item.fadeInDurationInSeconds,
		fps,
		frame,
		item.opacity,
		item.durationInFrames,
		item.fadeOutDurationInSeconds,
	]);

	const PageRenderer = useMemo(() => {
		switch (normalizeCaptionStyle(item.captionStyle)) {
			case 'colored-words':
				return ColoredWordsPage;
			case 'scaling-words':
				return ScalingWordsPage;
			case 'animated-background':
				return AnimatedBackgroundPage;
			default:
				return CaptionPage;
		}
	}, [item.captionStyle]);

	const style: React.CSSProperties = useMemo(() => {
		return {
			position: 'absolute',
			left: item.left,
			top: item.top,
			width: item.width,
			height: item.height,
			opacity: opacity,
			transform: `rotate(${item.rotation}deg)`,
			WebkitTextStroke: item.strokeWidth
				? `${item.strokeWidth}px ${item.strokeColor}`
				: '0',
			paintOrder: 'stroke',
		};
	}, [item, opacity]);

	const {pages} = useMemo(() => {
		return createTikTokStyleCaptions({
			captions: captionAsset.captions,
			combineTokensWithinMilliseconds: item.pageDurationInMilliseconds,
		});
	}, [captionAsset.captions, item.pageDurationInMilliseconds]);

	if (!loaded) {
		return null;
	}

	return (
		<div style={style} className="select-none">
			{pages.map((page, index) => {
				const nextPage = pages[index + 1] ?? null;
				const captionOffsetInSeconds = item.captionStartInSeconds;
				const subtitleStartFrame =
					(page.startMs / 1000) * fps - captionOffsetInSeconds * fps;
				const subtitleEndFrame = Math.min(
					nextPage
						? (nextPage.startMs / 1000) * fps - captionOffsetInSeconds * fps
						: Infinity,
					subtitleStartFrame + (SWITCH_CAPTIONS_EVERY_MS / 1000) * fps,
				);
				const durationInFrames = subtitleEndFrame - subtitleStartFrame;
				if (durationInFrames <= 0) {
					return null;
				}

				return (
					<Sequence
						key={index}
						from={subtitleStartFrame}
						durationInFrames={durationInFrames}
					>
						<PageRenderer
							captionWidth={item.width}
							fontFamily={item.fontFamily}
							fontStyle={item.fontStyle}
							key={index}
							page={page}
							lineHeight={item.lineHeight}
							letterSpacing={item.letterSpacing}
							color={item.color}
							direction={item.direction}
							align={item.align}
							fontSize={item.fontSize}
							highlightColor={item.highlightColor}
							maxLines={item.maxLines}
						/>
					</Sequence>
				);
			})}
		</div>
	);
};
