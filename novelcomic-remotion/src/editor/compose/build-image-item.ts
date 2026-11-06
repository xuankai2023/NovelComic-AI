import type {ImageAsset} from '../assets/assets';
import {domainInvariant} from '../comic/errors';
import type {TrackSemantic} from '../comic/types';
import type {ImageItem} from '../items/image/image-item-type';
import type {ImageMotion} from '../motion/types';
import type {TrackType} from '../state/types';

export type BuildImageItemInput = {
	id: string;
	assetId: string;
	remoteUrl: string;
	width: number;
	height: number;
	from: number;
	durationInFrames: number;
	compositionWidth: number;
	compositionHeight: number;
	filename?: string;
	shotId?: string;
	layerId?: string;
	trackId?: string;
	trackName?: string;
	semantic?: TrackSemantic;
	motion?: ImageMotion;
	fit?: 'contain' | 'cover';
	blurRadiusPx?: number;
	dimOpacity?: number;
	role?: 'panel-foreground' | 'panel-background';
};

export type BuiltImagePlacement = {
	item: ImageItem;
	asset: ImageAsset;
	track: TrackType;
};

const fitImageToCanvas = ({
	mediaWidth,
	mediaHeight,
	containerWidth,
	containerHeight,
	fit,
}: {
	mediaWidth: number;
	mediaHeight: number;
	containerWidth: number;
	containerHeight: number;
	fit: 'contain' | 'cover';
}): {width: number; height: number; top: number; left: number} => {
	const widthRatio = containerWidth / mediaWidth;
	const heightRatio = containerHeight / mediaHeight;
	const ratio =
		fit === 'cover'
			? Math.max(widthRatio, heightRatio)
			: Math.min(widthRatio, heightRatio);
	const width = Math.round(mediaWidth * ratio);
	const height = Math.round(mediaHeight * ratio);

	return {
		width,
		height,
		top: Math.round((containerHeight - height) / 2),
		left: Math.round((containerWidth - width) / 2),
	};
};

const filenameFromUrl = (remoteUrl: string, fallback: string): string => {
	try {
		const name = new URL(remoteUrl).pathname.split('/').filter(Boolean).pop();
		if (name) {
			return name;
		}
	} catch {
		return fallback;
	}

	return fallback;
};

const mimeFromFilename = (filename: string): string => {
	const lower = filename.toLowerCase();
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
		return 'image/jpeg';
	}

	if (lower.endsWith('.webp')) {
		return 'image/webp';
	}

	if (lower.endsWith('.gif')) {
		return 'image/gif';
	}

	return 'image/png';
};

export const buildImageItem = (
	input: BuildImageItemInput,
): BuiltImagePlacement => {
	if (
		!Number.isInteger(input.width) ||
		input.width < 1 ||
		!Number.isInteger(input.height) ||
		input.height < 1 ||
		input.compositionWidth < 1 ||
		input.compositionHeight < 1
	) {
		throw domainInvariant('Image dimensions must be positive', {
			itemId: input.id,
			assetId: input.assetId,
		});
	}

	const filename =
		input.filename ?? filenameFromUrl(input.remoteUrl, `${input.assetId}.png`);
	const fitted = fitImageToCanvas({
		mediaWidth: input.width,
		mediaHeight: input.height,
		containerWidth: input.compositionWidth,
		containerHeight: input.compositionHeight,
		fit: input.fit ?? 'contain',
	});
	const asset: ImageAsset = {
		id: input.assetId,
		type: 'image',
		filename,
		size: 0,
		remoteUrl: input.remoteUrl,
		remoteFileKey: null,
		mimeType: mimeFromFilename(filename),
		width: input.width,
		height: input.height,
	};
	const item: ImageItem = {
		id: input.id,
		type: 'image',
		assetId: input.assetId,
		durationInFrames: input.durationInFrames,
		from: input.from,
		top: fitted.top,
		left: fitted.left,
		width: fitted.width,
		height: fitted.height,
		opacity: 1,
		isDraggingInTimeline: false,
		borderRadius: 0,
		rotation: 0,
		keepAspectRatio: true,
		fadeInDurationInSeconds: 0,
		fadeOutDurationInSeconds: 0,
		cropLeft: 0,
		cropTop: 0,
		cropRight: 0,
		cropBottom: 0,
		shotId: input.shotId,
		layerId: input.layerId,
		motion: input.motion,
		...(input.fit ? {fit: input.fit} : {}),
		...(input.blurRadiusPx !== undefined
			? {blurRadiusPx: input.blurRadiusPx}
			: {}),
		...(input.dimOpacity !== undefined ? {dimOpacity: input.dimOpacity} : {}),
		...(input.role ? {role: input.role} : {}),
	};
	const track: TrackType = {
		id: input.trackId ?? `track:${input.id}`,
		items: [item.id],
		hidden: false,
		muted: false,
		name: input.trackName,
		shotId: input.shotId,
		semantic: input.semantic,
	};

	return {item, asset, track};
};
