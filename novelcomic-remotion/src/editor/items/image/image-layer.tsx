import React, {useContext, useMemo} from 'react';
import {Img, useCurrentFrame, useVideoConfig} from 'remotion';
import {rootBoneCssTransform} from '../../advanced/bone-rig';
import {RequireCachedAsset} from '../../caching/require-cached-asset';
import {ItemSelectedForCropContext} from '../../context-provider';
import {
	evaluateImagePose,
	findPreviousCrossfadeShot,
} from '../../motion/evaluate';
import {
	useOptionalPreferredLocalUrl,
	usePreferredLocalUrl,
} from '../../utils/find-asset-by-id';
import {
	useAssetFromAssetId,
	useOptionalAssetFromAssetId,
	useShotById,
	useShots,
} from '../../utils/use-context';
import {useCroppableLayer} from '../croppable-layer';
import {
	calculateFadeInOpacity,
	calculateFadeOutOpacity,
} from '../video/calculate-fade';
import {panelImageStyle} from './image-fit-style';
import {ImageItem} from './image-item-type';
import {MeshWarpImage} from './mesh-warp-image';

const ImageItemUnmemoized: React.FC<{
	item: ImageItem;
	cropBackground: boolean;
}> = ({item, cropBackground}) => {
	if (item.type !== 'image') {
		throw new Error('Item is not an image');
	}

	const localFrame = useCurrentFrame();
	const {
		fps,
		width: compositionWidth,
		height: compositionHeight,
	} = useVideoConfig();
	const itemSelectedForCrop = useContext(ItemSelectedForCropContext);
	const {shots} = useShots();
	const shot = useShotById(item.shotId);
	const itemIsBeingCropped = item.id === itemSelectedForCrop;
	const globalFrame = item.from + localFrame;

	const fadeOpacity = useMemo(() => {
		const inOpacity = calculateFadeInOpacity({
			currentFrame: localFrame,
			fadeInDurationInSeconds: item.fadeInDurationInSeconds,
			framesPerSecond: fps,
		});
		const outOpacity = calculateFadeOutOpacity({
			currentFrame: localFrame,
			fadeOutDurationInSeconds: item.fadeOutDurationInSeconds,
			framesPerSecond: fps,
			totalDurationInFrames: item.durationInFrames,
		});
		return inOpacity * outOpacity;
	}, [
		item.fadeInDurationInSeconds,
		item.fadeOutDurationInSeconds,
		item.durationInFrames,
		fps,
		localFrame,
	]);

	const pose = useMemo(() => {
		if (itemIsBeingCropped) {
			return null;
		}

		return evaluateImagePose({
			item,
			shot,
			previousShot: findPreviousCrossfadeShot(shots, shot),
			globalFrame,
			compositionWidth,
			compositionHeight,
			fadeOpacity,
		});
	}, [
		compositionHeight,
		compositionWidth,
		fadeOpacity,
		globalFrame,
		item,
		itemIsBeingCropped,
		shot,
		shots,
	]);

	const asset = useAssetFromAssetId(pose?.assetId ?? item.assetId);
	const maskAsset = useOptionalAssetFromAssetId(item.maskAssetId ?? '');
	const opacity = pose?.opacity ?? fadeOpacity * item.opacity;

	const {innerStyle, outerStyle} = useCroppableLayer({
		item,
		rotation: pose?.rotation ?? item.rotation,
		opacity,
		borderRadius: item.borderRadius,
		cropBackground,
		pose: pose ?? undefined,
	});

	const src = usePreferredLocalUrl(asset);
	const maskUrl = useOptionalPreferredLocalUrl(maskAsset);
	const fitStyle = panelImageStyle({
		...item,
		maskUrl: maskUrl ?? undefined,
	});
	const boneTransform = rootBoneCssTransform(item.motion?.boneRig, localFrame);
	const animatedOuterStyle = boneTransform
		? {
				...outerStyle,
				transform: `${outerStyle.transform ?? ''} ${boneTransform}`.trim(),
			}
		: outerStyle;

	const imageStyle = {
		...innerStyle,
		...fitStyle.image,
	};
	const image = item.motion?.meshGrid ? (
		<MeshWarpImage
			src={src}
			width={item.width}
			height={item.height}
			grid={item.motion.meshGrid}
			frame={localFrame}
			style={imageStyle}
		/>
	) : (
		<Img
			crossOrigin="anonymous"
			pauseWhenLoading
			style={imageStyle}
			src={src}
		/>
	);

	return (
		<div style={animatedOuterStyle}>
			<RequireCachedAsset asset={asset}>
				{maskAsset && maskUrl ? (
					<RequireCachedAsset asset={maskAsset}>{image}</RequireCachedAsset>
				) : (
					image
				)}
			</RequireCachedAsset>
			{fitStyle.dimOpacity !== undefined ? (
				<div
					style={{
						position: 'absolute',
						inset: 0,
						backgroundColor: '#000000',
						opacity: fitStyle.dimOpacity,
						pointerEvents: 'none',
					}}
				/>
			) : null}
		</div>
	);
};

export const ImageLayer = React.memo(ImageItemUnmemoized);
