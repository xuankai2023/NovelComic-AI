import type {ExpressionNode} from '../advanced/expressions';
import type {CurveHandle} from '../motion/types';

export const ADVANCED_SCHEMA_VERSION = 1;

export const ADVANCED_BLEND_MODES = [
	'normal',
	'multiply',
	'screen',
	'overlay',
	'darken',
	'lighten',
] as const;

export type AdvancedBlendMode = (typeof ADVANCED_BLEND_MODES)[number];

export type AdvancedTransform = {
	x: number;
	y: number;
	width: number;
	height: number;
	scaleX: number;
	scaleY: number;
	rotation: number;
	opacity: number;
	anchorX: number;
	anchorY: number;
};

export type AdvancedTransformKeyframe = {
	frame: number;
	x?: number;
	y?: number;
	scaleX?: number;
	scaleY?: number;
	rotation?: number;
	opacity?: number;
	easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
	handleIn?: CurveHandle;
	handleOut?: CurveHandle;
};

export type ExpressionProperty =
	| 'x'
	| 'y'
	| 'scaleX'
	| 'scaleY'
	| 'rotation'
	| 'opacity';

export type ExpressionDefinition = {
	id: string;
	property: ExpressionProperty;
	source: string;
	ast: ExpressionNode;
	dependencies: string[];
	seed?: number;
	enabled: boolean;
};

export type AdvancedTransformAnimation = {
	keyframes: AdvancedTransformKeyframe[];
	loop?: 'none' | 'repeat' | 'ping-pong';
	loopStartFrame?: number;
	loopEndFrame?: number;
};

export type MaskPoint = {
	x: number;
	y: number;
};

export type MaskDefinition = {
	id: string;
	mode: 'add' | 'subtract' | 'intersect';
	inverted: boolean;
	feather: number;
	expansion: number;
	points: MaskPoint[];
};

export type TrackMatteDefinition = {
	layerId: string;
	type: 'alpha' | 'alpha-inverted' | 'luma' | 'luma-inverted';
};

export type LayerNode = {
	id: string;
	itemId?: string;
	compositionId: string;
	sourceCompositionId?: string;
	from?: number;
	durationInFrames?: number;
	parentId?: string | null;
	name: string;
	semantic?: string;
	zIndex: number;
	visible: boolean;
	locked: boolean;
	transform: AdvancedTransform;
	motion?: AdvancedTransformAnimation;
	masks?: MaskDefinition[];
	matte?: TrackMatteDefinition;
	blendMode?: AdvancedBlendMode;
	expressionIds?: string[];
};

export type CompositionDefinition = {
	id: string;
	name: string;
	width: number;
	height: number;
	fps: number;
	durationInFrames: number;
	layerIds: string[];
	from?: number;
	timeOffset?: number;
};

export type SubtitleToken = {
	text: string;
	from: number;
	to: number;
};

export type SubtitleItem = {
	id: string;
	text: string;
	from: number;
	durationInFrames: number;
	tokens?: SubtitleToken[];
};

export type SubtitleTrack = {
	id: string;
	shotId?: string;
	style:
		| 'default'
		| 'colored-words'
		| 'scaling-words'
		| 'animated-background';
	items: SubtitleItem[];
};

export type MouthState = {
	from: number;
	to: number;
	assetId: string;
	viseme?: string;
};

export type LipSyncTrack = {
	id: string;
	mouthLayerId: string;
	dialogueItemId: string;
	mode: 'rule' | 'phoneme' | 'manual';
	states: MouthState[];
	fallbackState: string;
};

export type AdvancedProjectState = {
	schemaVersion: number;
	rootCompositionId: string;
	compositions: Record<string, CompositionDefinition>;
	layers: Record<string, LayerNode>;
	subtitles: Record<string, SubtitleTrack>;
	lipSyncTracks: Record<string, LipSyncTrack>;
	expressions: Record<string, ExpressionDefinition>;
};

export const createEmptyAdvancedProjectState = (
	width = 1080,
	height = 1920,
	fps = 30,
	durationInFrames = 1,
): AdvancedProjectState => {
	const rootCompositionId = 'composition:root';
	return {
		schemaVersion: ADVANCED_SCHEMA_VERSION,
		rootCompositionId,
		compositions: {
			[rootCompositionId]: {
				id: rootCompositionId,
				name: 'Main Composition',
				width,
				height,
				fps,
				durationInFrames,
				layerIds: [],
			},
		},
		layers: {},
		subtitles: {},
		lipSyncTracks: {},
		expressions: {},
	};
};
