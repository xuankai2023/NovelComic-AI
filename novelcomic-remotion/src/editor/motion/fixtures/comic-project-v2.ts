import type {ImageAsset} from '../../assets/assets';
import type {ImageItem} from '../../items/image/image-item-type';
import type {TrackType, UndoableState} from '../../state/types';

const imageAsset = (id: string, width: number, height: number): ImageAsset => {
	return {
		id,
		type: 'image',
		filename: `${id}.png`,
		size: 1,
		remoteUrl: `https://cdn.example.com/${id}.png`,
		remoteFileKey: null,
		mimeType: 'image/png',
		width,
		height,
	};
};

const imageItem = (
	item: Pick<
		ImageItem,
		| 'id'
		| 'assetId'
		| 'from'
		| 'durationInFrames'
		| 'left'
		| 'top'
		| 'width'
		| 'height'
		| 'shotId'
		| 'layerId'
	> &
		Partial<ImageItem>,
): ImageItem => {
	return {
		opacity: 1,
		borderRadius: 0,
		rotation: 0,
		isDraggingInTimeline: false,
		keepAspectRatio: true,
		fadeInDurationInSeconds: 0,
		fadeOutDurationInSeconds: 0,
		cropLeft: 0,
		cropTop: 0,
		cropRight: 0,
		cropBottom: 0,
		type: 'image',
		...item,
	};
};

const background = imageItem({
	id: 'item-shot-a-background',
	assetId: 'asset-background',
	shotId: 'shot-a',
	layerId: 'background',
	from: 0,
	durationInFrames: 120,
	left: 0,
	top: 0,
	width: 1080,
	height: 1920,
});

const character = imageItem({
	id: 'item-shot-a-character',
	assetId: 'asset-character',
	shotId: 'shot-a',
	layerId: 'character',
	from: 0,
	durationInFrames: 120,
	left: 180,
	top: 360,
	width: 720,
	height: 1400,
	motion: {
		preset: {
			id: 'breathing',
			parameters: {scale: 1.02},
			seed: 1,
		},
		transform: {
			keyframes: [
				{frame: 0, scaleX: 1, scaleY: 1, easing: 'ease-in-out'},
				{frame: 45, scaleX: 1.02, scaleY: 1.02, easing: 'ease-in-out'},
				{frame: 90, scaleX: 1, scaleY: 1, easing: 'ease-in-out'},
			],
			loop: 'ping-pong',
			loopStartFrame: 0,
			loopEndFrame: 90,
			anchorX: 0.5,
			anchorY: 0.5,
		},
	},
});

const eye = imageItem({
	id: 'item-shot-a-eye',
	assetId: 'asset-eye-open',
	shotId: 'shot-a',
	layerId: 'eye',
	from: 0,
	durationInFrames: 120,
	left: 390,
	top: 620,
	width: 300,
	height: 120,
	motion: {
		spriteStates: [
			{frame: 0, assetId: 'asset-eye-open'},
			{frame: 40, assetId: 'asset-eye-closed'},
			{frame: 46, assetId: 'asset-eye-open'},
		],
	},
});

const shotB = imageItem({
	id: 'item-shot-b-panel',
	assetId: 'asset-shot-b',
	shotId: 'shot-b',
	layerId: 'panel',
	from: 105,
	durationInFrames: 120,
	left: 0,
	top: 0,
	width: 1080,
	height: 1920,
});

const track = (
	id: string,
	shotId: string,
	semantic: TrackType['semantic'],
	itemId: string,
	name: string,
): TrackType => {
	return {
		id,
		shotId,
		semantic,
		name,
		items: [itemId],
		hidden: false,
		muted: false,
	};
};

export const comicProjectV2: UndoableState = {
	schemaVersion: 2,
	fps: 30,
	compositionWidth: 1080,
	compositionHeight: 1920,
	deletedAssets: [],
	shots: [
		{
			id: 'shot-a',
			name: 'camera-push',
			from: 0,
			durationInFrames: 120,
			layerTrackIds: [
				'track-shot-a-eye',
				'track-shot-a-character',
				'track-shot-a-background',
			],
			dialogueItemIds: [],
			transitionOut: {type: 'crossfade', durationInFrames: 15},
			cameraMotion: {
				keyframes: [
					{frame: 0, x: 0, y: 0, scale: 1, easing: 'linear'},
					{frame: 119, x: 0, y: 0, scale: 1.08, easing: 'ease-in-out'},
				],
				focalX: 540,
				focalY: 960,
			},
		},
		{
			id: 'shot-b',
			name: 'shot-b',
			from: 105,
			durationInFrames: 120,
			layerTrackIds: ['track-shot-b-panel'],
			dialogueItemIds: [],
			transitionOut: {type: 'cut'},
		},
	],
	tracks: [
		track('track-shot-b-panel', 'shot-b', 'other', shotB.id, 'shot-b'),
		track('track-shot-a-eye', 'shot-a', 'eye-open', eye.id, 'eye'),
		track(
			'track-shot-a-character',
			'shot-a',
			'body',
			character.id,
			'character',
		),
		track(
			'track-shot-a-background',
			'shot-a',
			'background',
			background.id,
			'background',
		),
	],
	items: {
		[shotB.id]: shotB,
		[eye.id]: eye,
		[character.id]: character,
		[background.id]: background,
	},
	assets: {
		'asset-background': imageAsset('asset-background', 1080, 1920),
		'asset-character': imageAsset('asset-character', 720, 1400),
		'asset-eye-open': imageAsset('asset-eye-open', 300, 120),
		'asset-eye-closed': imageAsset('asset-eye-closed', 300, 120),
		'asset-shot-b': imageAsset('asset-shot-b', 1080, 1920),
	},
};
