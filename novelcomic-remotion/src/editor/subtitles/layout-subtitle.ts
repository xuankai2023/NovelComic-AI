import type {SubtitleItem} from '../composition/types';

export type PositionedSubtitle = {
	text: string;
	lines: string[];
	x: number;
	y: number;
	width: number;
	height: number;
	visible: boolean;
};

const wrapText = (text: string, maxCharacters: number): string[] => {
	if (maxCharacters <= 0) {
		return [text];
	}

	const characters = [...text];
	const lines: string[] = [];
	for (let index = 0; index < characters.length; index += maxCharacters) {
		lines.push(characters.slice(index, index + maxCharacters).join(''));
	}
	return lines.length > 0 ? lines : [''];
};

export const layoutSubtitle = (
	item: SubtitleItem,
	frame: number,
	options: {
		canvasWidth: number;
		canvasHeight: number;
		fontSize: number;
		maxLines?: number;
		maxCharactersPerLine?: number;
		bottomOffset?: number;
	},
): PositionedSubtitle => {
	const visible =
		frame >= item.from && frame < item.from + item.durationInFrames;
	const lines = wrapText(
		item.text,
		options.maxCharactersPerLine ??
			Math.max(1, Math.floor(32_000 / options.fontSize)),
	).slice(0, options.maxLines ?? 2);
	const lineHeight = options.fontSize * 1.25;
	const height = lines.length * lineHeight;
	const width = Math.min(
		options.canvasWidth,
		(options.maxCharactersPerLine ?? 18) * options.fontSize,
	);

	return {
		text: item.text,
		lines,
		x: (options.canvasWidth - width) / 2,
		y: options.canvasHeight - (options.bottomOffset ?? 120) - height,
		width,
		height,
		visible,
	};
};
