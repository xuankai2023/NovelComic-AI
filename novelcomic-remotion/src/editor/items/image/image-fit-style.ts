import type {CSSProperties} from 'react';
import type {ImageItem, ImageMaskMode} from './image-item-type';

export type PanelImageStyle = {
	image: CSSProperties;
	dimOpacity?: number;
};

/** Blur and dim come from the item so Player, stills, and renders share one layer. */
export const panelImageStyle = (
	item: Pick<ImageItem, 'blurRadiusPx' | 'dimOpacity' | 'blendMode'> & {
		maskUrl?: string;
		maskMode?: ImageMaskMode;
	},
): PanelImageStyle => {
	const image: CSSProperties = {};
	if (
		item.blurRadiusPx !== undefined &&
		Number.isFinite(item.blurRadiusPx) &&
		item.blurRadiusPx > 0
	) {
		image.filter = `blur(${item.blurRadiusPx}px)`;
	}

	if (item.blendMode && item.blendMode !== 'normal') {
		image.mixBlendMode = item.blendMode as CSSProperties['mixBlendMode'];
	}

	if (item.maskUrl) {
		const maskMode = item.maskMode ?? 'alpha';
		const maskUrl = `url("${item.maskUrl}")`;
		image.maskImage =
			maskMode === 'inverse-alpha'
				? `linear-gradient(#fff, #fff), ${maskUrl}`
				: maskUrl;
		image.maskSize =
			maskMode === 'inverse-alpha' ? '100% 100%, 100% 100%' : '100% 100%';
		image.maskPosition = maskMode === 'inverse-alpha' ? '0 0, 0 0' : '0 0';
		image.maskRepeat =
			maskMode === 'inverse-alpha' ? 'no-repeat, no-repeat' : 'no-repeat';
		(image as CSSProperties & {maskMode?: string}).maskMode =
			maskMode === 'luma' ? 'luminance' : 'alpha';
		if (maskMode === 'inverse-alpha') {
			(image as CSSProperties & {maskComposite?: string}).maskComposite =
				'exclude';
			(
				image as CSSProperties & {
					WebkitMaskComposite?: string;
				}
			).WebkitMaskComposite = 'xor';
		}
	}

	const dimOpacity =
		item.dimOpacity !== undefined &&
		Number.isFinite(item.dimOpacity) &&
		item.dimOpacity > 0
			? item.dimOpacity
			: undefined;

	return {image, dimOpacity};
};
