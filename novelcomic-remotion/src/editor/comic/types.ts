import type {CameraAnimation} from '../motion/types';

export const VOICE_PROFILE_PROVIDERS = [
	'manual',
	'elevenlabs',
	'openai',
	'custom',
] as const;

export type VoiceProfileProvider = (typeof VOICE_PROFILE_PROVIDERS)[number];

export type VoiceProfile = {
	id: string;
	characterId: string;
	displayName?: string;
	provider: VoiceProfileProvider;
	voiceId: string;
	style?: string;
	language?: string;
	defaultForCharacter?: boolean;
	enabled?: boolean;
};

export const COMIC_LAYER_SEMANTICS = [
	'background',
	'foreground',
	'body',
	'head',
	'arm-left',
	'arm-right',
	'hair',
	'eye-open',
	'eye-closed',
	'mouth-closed',
	'mouth-half',
	'mouth-open',
	'effect',
	'other',
] as const;

export type ComicLayerSemantic = (typeof COMIC_LAYER_SEMANTICS)[number];

export type TrackSemantic = ComicLayerSemantic | 'dialogue' | 'effect';

export const COMIC_TRACK_ROLES = [
	'source',
	'clean-plate',
	'cutout',
	'dialogue',
	'other',
] as const;

export type ComicTrackRole = (typeof COMIC_TRACK_ROLES)[number];

export type ShotTransition =
	| {type: 'cut'}
	| {type: 'crossfade'; durationInFrames: number};

export type Shot = {
	id: string;
	name: string;
	from: number;
	durationInFrames: number;
	layerTrackIds: string[];
	dialogueItemIds: string[];
	transitionOut?: ShotTransition;
	cameraMotion?: CameraAnimation;
	diagnostics?: string[];
};

export const MOTION_POLICIES = [
	'static',
	'camera-only',
	'subtle',
	'free',
] as const;

export type MotionPolicy = (typeof MOTION_POLICIES)[number];

export type LayerBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type LayerAnchor = {
	x: number;
	y: number;
};

export type ComicLayer = {
	layerId: string;
	name: string;
	semantic: ComicLayerSemantic;
	imageUrl: string;
	maskUrl?: string;
	isCleanPlate?: boolean;
	opacity?: number;
	zIndex: number;
	visible: boolean;
	bounds: LayerBounds;
	anchor: LayerAnchor;
	confidence: number;
	motionPolicy: MotionPolicy;
};

export type LayerDiagnostics = {
	recompositionScore: number;
	alphaHoleRatio: number;
	edgeArtifactScore: number;
	requiresFallback: boolean;
	warnings: string[];
};

export type LayerPackage = {
	schemaVersion: 1;
	projectId: string;
	shotId: string;
	sourceUrl: string;
	canvas: {
		width: number;
		height: number;
	};
	layers: ComicLayer[];
	diagnostics: LayerDiagnostics;
};

export type OutputBatch = {
	batchId: string;
	batchIndex: number;
	fromFrame: number;
	endFrameInclusive: number;
	durationInFrames: number;
	shotIds: string[];
	reason: string;
};

export const DELIVERY_FILE_CATEGORIES = [
	'source',
	'panel',
	'layer',
	'manifest',
	'audio',
	'subtitle',
	'project',
	'preview',
	'final-video',
] as const;

export type DeliveryFileCategory = (typeof DELIVERY_FILE_CATEGORIES)[number];

export type DeliveryFileEntry = {
	path: string;
	category: DeliveryFileCategory;
	order: number;
	url?: string;
	checksum?: string;
	sizeBytes?: number;
	missingReason?: string;
};

export type DeliveryPackageManifest = {
	schemaVersion: 1;
	projectId: string;
	generatedAt: string;
	projectContentHash: string;
	/** Optional traceability metadata supplied by the RenderJob input snapshot. */
	inputSnapshotId?: string;
	inputRevision?: number;
	inputContentHash?: string;
	preflightHash?: string;
	playOrder: string[];
	batches: OutputBatch[];
	files: DeliveryFileEntry[];
	layerPackages?: LayerPackage[];
};

export type ProjectIssue = {
	severity: 'error' | 'warning';
	code: string;
	message: string;
	shotId?: string;
	trackId?: string;
	itemId?: string;
	assetId?: string;
	frame?: number;
	property?: string;
	suggestion?: string;
};
