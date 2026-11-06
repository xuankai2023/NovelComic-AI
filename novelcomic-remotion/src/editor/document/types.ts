import type {CameraRawSettings} from './camera-raw';

/** The versioned, compositor-first document model.  This module deliberately
 * has no React, Remotion, IndexedDB, or server dependencies. */

export const DOCUMENT_SCHEMA_VERSION = 1 as const;

export type DocumentColor = {r: number; g: number; b: number; a: number};
export type BlendMode =
	| 'normal'
	| 'multiply'
	| 'screen'
	| 'overlay'
	| 'darken'
	| 'lighten'
	| 'color-dodge'
	| 'color-burn'
	| 'hard-light'
	| 'soft-light'
	| 'difference'
	| 'exclusion'
	| 'hue'
	| 'saturation'
	| 'color'
	| 'luminosity';
export const BLEND_MODES: readonly BlendMode[] = [
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
];

export type LayerTransform = {
	originX: number;
	originY: number;
	width: number;
	height: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
	sampling: 'high' | 'smooth' | 'nearest';
};

export type AssetRecord = {
	id: string;
	kind: 'raster' | 'mask' | 'font' | 'audio' | 'video';
	originalName: string;
	mimeType: string;
	width?: number;
	height?: number;
	byteSize: number;
	objectKey: string;
	previewObjectKey?: string;
	contentHash: string;
};

export type MaskEditKind = 'paint' | 'erase' | 'blur' | 'refine' | 'invert';

export type RasterMask = {
	assetId: string;
	enabled: boolean;
	linkedToLayer: boolean;
	placement?: LayerTransform;
	invert: boolean;
	feather: number;
};
export type LiveMask = {
	sourceLayerId: string;
	mode: 'alpha' | 'alpha-inverted' | 'luma' | 'luma-inverted';
};

export type LevelsChannel = {
	inputBlack: number;
	inputWhite: number;
	gamma: number;
	outputBlack: number;
	outputWhite: number;
};
export type CurvePoint = {x: number; y: number};
export type CurveChannel = {
	channel: 'rgb' | 'red' | 'green' | 'blue';
	points: CurvePoint[];
};
export type BlackWhiteSettings = {
	reds: number;
	yellows: number;
	greens: number;
	cyans: number;
	blues: number;
	magentas: number;
	tint?: DocumentColor;
};
export type ColorBalanceSettings = {
	shadows: [number, number, number];
	midtones: [number, number, number];
	highlights: [number, number, number];
	preserveLuminosity: boolean;
};
export type CameraRawAdjustmentContent = {kind: 'camera-raw'; settings: CameraRawSettings};
export type AdjustmentContent =
	| {
		kind: 'hue-saturation';
		hue: number;
		saturation: number;
		lightness: number;
		colorize: boolean;
	}
	| {kind: 'levels'; channels: LevelsChannel[]}
	| {kind: 'curves'; channels: CurveChannel[]}
	| {kind: 'exposure'; exposure: number; offset: number; gamma: number}
	| {
		kind: 'gradient-map';
		shadows: DocumentColor;
		highlights: DocumentColor;
		reversed: boolean;
	}
	| {kind: 'grain'; amount: number; monochromatic: boolean; seed: number}
	| {kind: 'invert'}
	| {kind: 'black-white'; settings: BlackWhiteSettings}
	| {kind: 'color-balance'; settings: ColorBalanceSettings}
	| {kind: 'gaussian-blur'; radius: number}
	| {kind: 'motion-blur'; angle: number; distance: number}
	| {
		kind: 'add-noise';
		amount: number;
		gaussian: boolean;
		monochromatic: boolean;
		seed: number;
	}
	| CameraRawAdjustmentContent;
export type AdjustmentContentWithCameraRaw = AdjustmentContent;

export type StrokeEffect = {
	enabled: boolean;
	color: DocumentColor;
	size: number;
	position: 'inside' | 'center' | 'outside';
	opacity: number;
};
export type ShadowEffect = {
	enabled: boolean;
	color: DocumentColor;
	opacity: number;
	angle: number;
	distance: number;
	size: number;
	spread: number;
};
export type GlowEffect = {
	enabled: boolean;
	color: DocumentColor;
	opacity: number;
	size: number;
	spread: number;
};
export type ColorOverlayEffect = {
	enabled: boolean;
	color: DocumentColor;
	opacity: number;
	blendMode: BlendMode;
};
export type LayerEffects = {
	stroke?: StrokeEffect;
	dropShadow?: ShadowEffect;
	colorOverlay?: ColorOverlayEffect;
	innerShadow?: ShadowEffect;
	outerGlow?: GlowEffect;
	innerGlow?: GlowEffect;
};

export type LayerEffectKind = keyof LayerEffects;
export type LayerEffect = NonNullable<LayerEffects[LayerEffectKind]>;

export type LayerContent =
	| {kind: 'pixel'; assetId: string}
	| {kind: 'group'; group: true}
	| AdjustmentContent
	| {
			kind: 'text';
			text: string;
			fontFamily: string;
			fontSize: number;
			color: DocumentColor;
			align: 'left' | 'center' | 'right';
			lineHeight: number;
			letterSpacing: number;
			runs?: Array<{
				start: number;
				end: number;
				fontFamily?: string;
				fontSize?: number;
				color?: DocumentColor;
			}>;
	  }
	| {
			kind: 'shape';
			shape: 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'line';
			fill: DocumentColor;
			stroke?: DocumentColor;
			strokeWidth: number;
			cornerRadius?: number;
		};

export type TextLayerContent = Extract<LayerContent, {kind: 'text'}>;
export type ShapeLayerContent = Extract<LayerContent, {kind: 'shape'}>;
export type AdjustmentLayerContent = AdjustmentContent;

export type AnimatedProperty =
	| 'x'
	| 'y'
	| 'width'
	| 'height'
	| 'rotation'
	| 'scaleX'
	| 'scaleY'
	| 'opacity';
export type Easing = 'linear' | 'hold' | 'ease-in' | 'ease-out' | 'ease-in-out';
export type PropertyTrack = {
	baseValue: number;
	keyframes: Array<{frame: number; value: number; easing: Easing}>;
};
export type LayerAnimation = {
	properties: Partial<Record<AnimatedProperty, PropertyTrack>>;
};
export type AnimationDocument = {fps: number; durationInFrames: number};
export type SelectionRect = {x: number; y: number; width: number; height: number};
/** Document-space outline. `empty` is an explicit empty selection, distinct from no selection. */
export type SelectionShape =
	| {kind: 'empty'}
	| {kind: 'rect'; bounds: SelectionRect}
	| {kind: 'ellipse'; bounds: SelectionRect}
	| {kind: 'polygon'; points: Array<{x: number; y: number}>}
	| {kind: 'rects'; rects: SelectionRect[]}
	| {kind: 'union'; shapes: SelectionShape[]}
	| {kind: 'difference'; base: SelectionShape; cut: SelectionShape};
export type SelectionGeometry = {antialiased: boolean; shape: SelectionShape};
export type SelectionRecord = {
	id: string;
	bounds: SelectionRect;
	feather: number;
	inverted?: boolean;
	maskAssetId?: string;
	geometry?: SelectionGeometry;
};
export type Guide = {
	id: string;
	orientation: 'horizontal' | 'vertical';
	position: number;
	locked?: boolean;
};
export type DocumentMetadata = {
	createdAt?: string;
	updatedAt?: string;
	author?: string;
	[key: string]: unknown;
};

export type LayerNode = {
	id: string;
	name: string;
	kind: 'pixel' | 'group' | 'adjustment' | 'text' | 'shape';
	parentId: string | null;
	order: number;
	visible: boolean;
	locked: boolean;
	solo: boolean;
	opacity: number;
	blendMode: BlendMode;
	transform: LayerTransform;
	content: LayerContent;
	mask?: RasterMask;
	liveMaskSourceId?: string;
	liveMask?: LiveMask;
	effects?: LayerEffects;
	animation?: LayerAnimation;
};
export type DocumentState = {
	schemaVersion: 1;
	documentId: string;
	projectId: string;
	name: string;
	colorSpace: 'sRGB';
	width: number;
	height: number;
	resolution: number;
	rootLayerIds: string[];
	layers: Record<string, LayerNode>;
	assets: Record<string, AssetRecord>;
	selections: Record<string, SelectionRecord>;
	guides: Guide[];
	animation?: AnimationDocument;
	metadata: DocumentMetadata;
};

export type DocumentIssueSeverity = 'error' | 'warning';
export type DocumentIssue = {
	severity: DocumentIssueSeverity;
	code: string;
	path?: string;
	message: string;
};
export type MigrationReport = {
	fromVersion: number;
	toVersion: number;
	changes: string[];
	warnings: string[];
};
