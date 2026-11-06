import {DropPosition} from '../assets/drop-position';
import {fitElementSizeInContainer} from './fit-element-size-in-container';

interface CalculateMediaDimensionsForCanvasParams {
	mediaWidth: number;
	mediaHeight: number;
	containerWidth: number;
	containerHeight: number;
	dropPosition: DropPosition | null;
}

export const calculateMediaDimensionsForCanvas = ({
	mediaWidth,
	mediaHeight,
	containerWidth,
	containerHeight,
	dropPosition,
}: CalculateMediaDimensionsForCanvasParams): {
	width: number;
	height: number;
	top: number;
	left: number;
} => {
	const dimensions = fitElementSizeInContainer({
		containerSize: {
			width: containerWidth,
			height: containerHeight,
		},
		elementSize: {
			width: mediaWidth,
			height: mediaHeight,
		},
	});

	const left = dropPosition
		? dropPosition.x - dimensions.width / 2
		: (containerWidth - dimensions.width) / 2;
	const top = dropPosition
		? dropPosition.y - dimensions.height / 2
		: (containerHeight - dimensions.height) / 2;

	return {
		width: Math.round(dimensions.width),
		height: Math.round(dimensions.height),
		top: Math.round(top),
		left: Math.round(left),
	};
};
