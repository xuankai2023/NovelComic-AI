import {useContext, useMemo} from 'react';
import {ItemSelectedForCropContext} from '../context-provider';
import {FEATURE_CROP_BACKGROUNDS} from '../flags';
import type {EvaluatedImagePose} from '../motion/types';
import {getCropFromItem} from '../utils/get-crop-from-item';
import {
	getAnchorTransformOrigin,
	getRectAfterCrop,
} from '../utils/get-dimensions-after-crop';
import {EditorStarterItem} from './item-type';

export const useCroppableLayer = ({
	item,
	rotation,
	opacity,
	borderRadius,
	cropBackground,
	pose,
}: {
	item: EditorStarterItem;
	rotation: number;
	opacity: number;
	borderRadius: number;
	cropBackground: boolean;
	pose?: EvaluatedImagePose;
}) => {
	const itemSelectedForCrop = useContext(ItemSelectedForCropContext);
	const itemIsBeingCropped = item.id === itemSelectedForCrop;

	const rectAfterCrop = useMemo(() => {
		if (cropBackground) {
			return {
				left: pose?.left ?? item.left,
				top: pose?.top ?? item.top,
				width: pose?.width ?? item.width,
				height: pose?.height ?? item.height,
			};
		}

		return getRectAfterCrop(item, pose);
	}, [item, cropBackground, pose]);
	const crop = useMemo(() => getCropFromItem(item), [item]);

	if (!crop) {
		throw new Error('Crop not implemented for this item type');
	}

	const resolvedRotation = pose?.rotation ?? rotation;
	const resolvedOpacity = pose?.opacity ?? opacity;
	const layoutWidth = pose?.width ?? item.width;
	const layoutHeight = pose?.height ?? item.height;
	const transformOrigin = pose
		? getAnchorTransformOrigin({
				anchorX: pose.anchorX,
				anchorY: pose.anchorY,
				crop: cropBackground ? null : crop,
			})
		: undefined;

	const innerStyle: React.CSSProperties = useMemo(() => {
		return {
			width: layoutWidth,
			left: cropBackground ? 0 : -(crop.cropLeft * layoutWidth),
			top: cropBackground ? 0 : -(crop.cropTop * layoutHeight),
			height: layoutHeight,
			position: 'absolute',
			objectFit: 'cover',
			maxWidth: 'unset',
		};
	}, [crop.cropLeft, crop.cropTop, cropBackground, layoutHeight, layoutWidth]);

	const outerStyle: React.CSSProperties = useMemo(() => {
		return {
			position: 'absolute',
			left: rectAfterCrop.left,
			top: rectAfterCrop.top,
			transform: `rotate(${resolvedRotation}deg)`,
			transformOrigin,
			// https://www.remotion.dev/docs/editor-starter/cropping#crop-backgrounds
			opacity: cropBackground
				? 0.3
				: itemIsBeingCropped && FEATURE_CROP_BACKGROUNDS
					? 1
					: resolvedOpacity,
			overflow: 'hidden',
			width: rectAfterCrop.width,
			height: rectAfterCrop.height,
			borderRadius: cropBackground ? 0 : borderRadius,
		};
	}, [
		borderRadius,
		cropBackground,
		itemIsBeingCropped,
		rectAfterCrop.height,
		rectAfterCrop.left,
		rectAfterCrop.top,
		rectAfterCrop.width,
		resolvedOpacity,
		resolvedRotation,
		transformOrigin,
	]);

	return useMemo(() => {
		return {
			innerStyle,
			outerStyle,
		};
	}, [innerStyle, outerStyle]);
};
