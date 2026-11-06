import type {CSSProperties} from 'react';
import type {AdjustmentContent, DocumentColor} from '../document';

const percent = (value: number) => `${value}%`;
const color = (value: DocumentColor) => `rgba(${value.r}, ${value.g}, ${value.b}, ${value.a})`;

export const adjustmentFilter = (content: AdjustmentContent): string => {
	switch (content.kind) {
		case 'hue-saturation':
			return `hue-rotate(${content.hue}deg) saturate(${percent(100 + content.saturation)}) brightness(${percent(100 + content.lightness)})`;
		case 'levels': {
			const channel = content.channels[0];
			if (!channel) return '';
			const contrast = channel.inputWhite === channel.inputBlack ? 1 : 100 / (channel.inputWhite - channel.inputBlack) * 255;
			return `brightness(${percent(Math.max(0, channel.outputWhite - channel.outputBlack) / 255 * 100)}) contrast(${percent(Math.max(0, contrast))})`;
		}
		case 'curves':
			return content.channels.length ? 'contrast(105%)' : '';
		case 'exposure':
			return `brightness(${percent(100 * 2 ** content.exposure)}) contrast(${percent(100 + content.offset * 100)})`;
		case 'gradient-map':
			return `saturate(0) contrast(110%) drop-shadow(0 0 0 ${color(content.reversed ? content.shadows : content.highlights)})`;
		case 'grain':
			return `contrast(${percent(100 + content.amount * 20)})`;
		case 'gaussian-blur':
			return `blur(${Math.max(0, content.radius)}px)`;
		case 'invert':
			return 'invert(1)';
		case 'black-white':
			return 'grayscale(1)';
		case 'color-balance':
			return `saturate(${percent(100 + Math.abs(content.settings.midtones[0]) / 2)})`;
		case 'motion-blur':
			return `blur(${Math.max(0, content.distance / 2)}px)`;
		case 'add-noise':
			return `contrast(${percent(100 + content.amount * 10)})`;
		case 'camera-raw':
			// Remotion's DOM path gets a faithful fast approximation for the basic
			// light/color controls; the Canvas2D export path evaluates every control
			// through applyCameraRaw.
			return [
				`brightness(${percent(100 * 2 ** content.settings.exposure)})`,
				`contrast(${percent(100 + content.settings.contrast)})`,
				`saturate(${percent(100 + content.settings.saturation + content.settings.vibrance / 2)})`,
				`hue-rotate(${content.settings.tint / 8}deg)`,
			].join(' ');
	}
};

export const adjustmentStyle = (content: AdjustmentContent, opacity: number): CSSProperties => ({
		filter: adjustmentFilter(content) || undefined,
		opacity,
		pointerEvents: 'none',
});
