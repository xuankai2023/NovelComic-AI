import type {ImageMotion} from '../../motion/types';
import {
	BaseItem,
	CanHaveBorderRadius,
	CanHaveCrop,
	CanHaveRotation,
} from '../shared';

export const IMAGE_BLEND_MODES = [
	'normal',
	'multiply',
	'screen',
	'overlay',
	'darken',
	'lighten',
	'color-dodge',
	'color-burn',
	'hard-light',
	'soft-light',
	'difference',
	'exclusion',
	'hue',
	'saturation',
	'color',
	'luminosity',
] as const;

export type ImageBlendMode = (typeof IMAGE_BLEND_MODES)[number];

export const IMAGE_MASK_MODES = ['alpha', 'luma', 'inverse-alpha'] as const;

export type ImageMaskMode = (typeof IMAGE_MASK_MODES)[number];

export type ImageItem = BaseItem &
	CanHaveBorderRadius &
	CanHaveCrop &
	CanHaveRotation & {
		type: 'image';
		assetId: string;
		keepAspectRatio: boolean;
		fadeInDurationInSeconds: number;
		fadeOutDurationInSeconds: number;
		motion?: ImageMotion;
		spriteAssetIds?: string[];
		shotId?: string;
		layerId?: string;
		fit?: 'contain' | 'cover';
		blurRadiusPx?: number;
		dimOpacity?: number;
		role?: 'panel-foreground' | 'panel-background';
		/** CSS compositing mode. Missing values are treated as `normal`. */
		blendMode?: ImageBlendMode;
		/** An image asset used as an alpha/luminance track matte. */
		maskAssetId?: string;
		maskMode?: ImageMaskMode;
	};
