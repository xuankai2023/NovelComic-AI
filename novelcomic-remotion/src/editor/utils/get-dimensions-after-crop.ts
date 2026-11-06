import {EditorStarterItem} from '../items/item-type';
import {getCropFromItem} from './get-crop-from-item';

export type CropSourceRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

export const getRectAfterCrop = (
	item: EditorStarterItem,
	source?: CropSourceRect,
) => {
	const left = source?.left ?? item.left;
	const top = source?.top ?? item.top;
	const width = source?.width ?? item.width;
	const height = source?.height ?? item.height;
	const crop = getCropFromItem(item);

	if (!crop) {
		return {
			left,
			top,
			width,
			height,
		};
	}

	return {
		left: left + crop.cropLeft * width,
		top: top + crop.cropTop * height,
		width: width - crop.cropLeft * width - crop.cropRight * width,
		height: height - crop.cropTop * height - crop.cropBottom * height,
	};
};

export const getAnchorTransformOrigin = ({
	anchorX,
	anchorY,
	crop,
}: {
	anchorX: number;
	anchorY: number;
	crop: {
		cropLeft: number;
		cropTop: number;
		cropRight: number;
		cropBottom: number;
	} | null;
}): string => {
	if (!crop) {
		return `${anchorX * 100}% ${anchorY * 100}%`;
	}

	const widthRatio = 1 - crop.cropLeft - crop.cropRight;
	const heightRatio = 1 - crop.cropTop - crop.cropBottom;
	if (widthRatio <= 0 || heightRatio <= 0) {
		return '50% 50%';
	}

	return `${((anchorX - crop.cropLeft) / widthRatio) * 100}% ${((anchorY - crop.cropTop) / heightRatio) * 100}%`;
};
