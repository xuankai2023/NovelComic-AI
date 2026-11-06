import type {CSSProperties} from 'react';
import type {EvaluatedMask, EvaluatedRenderLayer} from './types';

export type MaskAssetResolver = (assetId: string) => string | undefined;

export const maskStyle = (
	layer: EvaluatedRenderLayer,
	masks: readonly EvaluatedMask[],
	resolveAsset: MaskAssetResolver,
	liveMaskUrl?: string,
): CSSProperties => {
	const active = masks
		.filter((entry) => entry.mask.enabled)
		.map((entry) => ({entry, url: resolveAsset(entry.mask.assetId)}))
		.filter((entry): entry is {entry: EvaluatedMask; url: string} =>
			Boolean(entry.url),
		);
	const live =
		liveMaskUrl && layer.liveMask
			? {url: liveMaskUrl, invert: layer.liveMask.mode.endsWith('inverted')}
			: null;
	if (!active.length && !live) return {};
	const images = active.map(({entry, url}) =>
		entry.mask.invert
			? `linear-gradient(#fff, #fff), url("${url}")`
			: `url("${url}")`,
	);
	const sizes = active.map(
		({entry}) => `${entry.transform.width}px ${entry.transform.height}px`,
	);
	const positions = active.map(
		({entry}) =>
			`${entry.transform.x - layer.transform.x}px ${entry.transform.y - layer.transform.y}px`,
	);
	if (live) {
		images.push(
			live.invert
				? `linear-gradient(#fff, #fff), url("${live.url}")`
				: `url("${live.url}")`,
		);
		sizes.push('100% 100%');
		positions.push('0 0');
	}
	return {
		maskImage: images.join(', '),
		WebkitMaskImage: images.join(', '),
		maskSize: sizes.join(', '),
		WebkitMaskSize: sizes.join(', '),
		maskPosition: positions.join(', '),
		WebkitMaskPosition: positions.join(', '),
		maskRepeat: 'no-repeat',
		WebkitMaskRepeat: 'no-repeat',
		maskComposite: images.length > 1 ? 'intersect' : undefined,
		WebkitMaskComposite: images.length > 1 ? 'source-in' : undefined,
	};
};
