import {PreviewSize} from 'remotion';
import {Rect} from './fit-element-size-in-container';

export type Size = {
	width: number;
	height: number;
	left: number;
	top: number;
	windowSize: {
		width: number;
		height: number;
	};
};

export type CanvasTransformation = {
	centerX: number;
	centerY: number;
	xCorrection: number;
	yCorrection: number;
	scale: number;
};

export const calculateScale = ({
	previewSize,
	compositionWidth,
	compositionHeight,
	canvasSize,
}: {
	previewSize: PreviewSize['size'];
	compositionWidth: number;
	compositionHeight: number;
	canvasSize: {width: number; height: number};
}) => {
	if (previewSize !== 'auto') {
		return Number(previewSize);
	}

	if (compositionWidth <= 0 || compositionHeight <= 0) {
		return 1;
	}

	return Math.min(
		canvasSize.width / compositionWidth,
		canvasSize.height / compositionHeight,
	);
};

export const calculateCanvasTransformation = ({
	previewSize,
	compositionWidth,
	compositionHeight,
	canvasSize,
}: {
	previewSize: PreviewSize['size'];
	compositionWidth: number;
	compositionHeight: number;
	canvasSize: Rect;
}): CanvasTransformation => {
	const scale = calculateScale({
		canvasSize,
		compositionHeight,
		compositionWidth,
		previewSize,
	});

	const correction = 0 - (1 - scale) / 2;
	const xCorrection = correction * compositionWidth;
	const yCorrection = correction * compositionHeight;
	const width = compositionWidth * scale;
	const height = compositionHeight * scale;
	const centerX = canvasSize.width / 2 - width / 2;
	const centerY = canvasSize.height / 2 - height / 2;
	return {
		centerX,
		centerY,
		xCorrection,
		yCorrection,
		scale,
	};
};
