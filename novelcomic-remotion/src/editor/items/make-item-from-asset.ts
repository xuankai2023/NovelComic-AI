import {EditorStarterAsset} from '../assets/assets';
import {DropPosition} from '../assets/drop-position';
import {byDefaultKeepAspectRatioMap} from '../utils/aspect-ratio';
import {calculateMediaDimensionsForCanvas} from '../utils/dimension-utils';
import {generateRandomId} from '../utils/generate-random-id';
import {AudioItem} from './audio/audio-item-type';
import {GifItem} from './gif/gif-item-type';
import {ImageItem} from './image/image-item-type';
import {EditorStarterItem} from './item-type';
import {VideoItem} from './video/video-item-type';

type InsertableAsset = Exclude<EditorStarterAsset, {type: 'caption'}>;

export const canMakeItemFromAsset = (
	asset: EditorStarterAsset,
): asset is InsertableAsset => asset.type !== 'caption';

export const makeItemFromAsset = ({
	asset,
	currentFrame,
	fps,
	compositionWidth,
	compositionHeight,
	dropPosition,
}: {
	asset: InsertableAsset;
	currentFrame: number;
	fps: number;
	compositionWidth: number;
	compositionHeight: number;
	dropPosition: DropPosition | null;
}): EditorStarterItem => {
	const id = generateRandomId();

	if (asset.type === 'audio') {
		const item: AudioItem = {
			id,
			durationInFrames: Math.floor(asset.durationInSeconds * fps),
			audioStartFromInSeconds: 0,
			from: currentFrame,
			type: 'audio',
			top: 0,
			left: 0,
			width: 100,
			height: 100,
			opacity: 1,
			decibelAdjustment: 0,
			playbackRate: 1,
			audioFadeInDurationInSeconds: 0,
			audioFadeOutDurationInSeconds: 0,
			assetId: asset.id,
			isDraggingInTimeline: false,
		};
		return item;
	}

	const content = calculateMediaDimensionsForCanvas({
		mediaWidth: asset.width,
		mediaHeight: asset.height,
		containerWidth: compositionWidth,
		containerHeight: compositionHeight,
		dropPosition,
	});

	if (asset.type === 'video') {
		const item: VideoItem = {
			id,
			durationInFrames: Math.floor(asset.durationInSeconds * fps),
			videoStartFromInSeconds: 0,
			from: currentFrame,
			type: 'video',
			assetId: asset.id,
			isDraggingInTimeline: false,
			top: content.top,
			left: content.left,
			width: content.width,
			height: content.height,
			opacity: 1,
			borderRadius: 0,
			rotation: 0,
			decibelAdjustment: 0,
			playbackRate: 1,
			audioFadeInDurationInSeconds: 0,
			audioFadeOutDurationInSeconds: 0,
			fadeInDurationInSeconds: 0,
			fadeOutDurationInSeconds: 0,
			keepAspectRatio: byDefaultKeepAspectRatioMap.video,
			cropBottom: 0,
			cropTop: 0,
			cropLeft: 0,
			cropRight: 0,
		};
		return item;
	}

	if (asset.type === 'gif') {
		const item: GifItem = {
			id,
			durationInFrames: Math.floor(asset.durationInSeconds * fps),
			gifStartFromInSeconds: 0,
			top: content.top,
			left: content.left,
			width: content.width,
			height: content.height,
			from: currentFrame,
			type: 'gif',
			opacity: 1,
			borderRadius: 0,
			rotation: 0,
			playbackRate: 1,
			assetId: asset.id,
			isDraggingInTimeline: false,
			keepAspectRatio: byDefaultKeepAspectRatioMap.gif,
			fadeInDurationInSeconds: 0,
			fadeOutDurationInSeconds: 0,
			cropLeft: 0,
			cropTop: 0,
			cropRight: 0,
			cropBottom: 0,
		};
		return item;
	}

	const item: ImageItem = {
		id,
		durationInFrames: fps * 2,
		top: content.top,
		left: content.left,
		width: content.width,
		height: content.height,
		from: currentFrame,
		type: 'image',
		opacity: 1,
		borderRadius: 0,
		rotation: 0,
		assetId: asset.id,
		isDraggingInTimeline: false,
		keepAspectRatio: byDefaultKeepAspectRatioMap.image,
		fadeInDurationInSeconds: 0,
		fadeOutDurationInSeconds: 0,
		cropLeft: 0,
		cropTop: 0,
		cropRight: 0,
		cropBottom: 0,
	};
	return item;
};
