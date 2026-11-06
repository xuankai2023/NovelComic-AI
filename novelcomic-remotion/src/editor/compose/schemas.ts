import {z, type ZodType} from 'zod';
import type {
	AdjustmentLayer,
	BoneRig,
	LayerGroup,
	MeshGrid,
	MeshKeyframe,
	PenPath,
} from '../advanced/types';
import {MAX_ITEMS, MAX_KEYFRAMES_PER_ITEM, MAX_SHOTS} from '../comic/limits';
import {CLEAN_PLATE_STATUSES} from '../comic/manual-layer-types';
import {
	COMIC_LAYER_SEMANTICS,
	MOTION_POLICIES,
	VOICE_PROFILE_PROVIDERS,
	type LayerPackage,
	type Shot,
} from '../comic/types';
import {
	IMAGE_BLEND_MODES,
	IMAGE_MASK_MODES,
} from '../items/image/image-item-type';
import {CAMERA_PRESET_IDS, ITEM_PRESET_IDS} from '../motion/presets';
import {
	EASING_NAMES,
	TRANSFORM_ANIMATION_PROPERTIES,
	TRANSFORM_LOOPS,
	type CameraAnimation,
	type ImageMotion,
} from '../motion/types';
import type {UndoableState} from '../state/types';

const finiteNumber = z.number().finite();
const frameSchema = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

export const remoteUrlSchema = z.url().refine((value) => {
	return new URL(value).protocol === 'https:';
}, 'HTTPS is required');

export const draftEnvelopeSchema = z.object({
	clientRequestId: z.string().min(1).optional(),
	expectedRevision: z.number().int().nonnegative().optional(),
});

export const frameRangeSchema = z
	.tuple([frameSchema, frameSchema])
	.refine(([start, end]) => {
		return end >= start;
	}, 'frameRange end is inclusive and must not precede start');

const easingSchema = z.enum(EASING_NAMES);
const loopSchema = z.enum(TRANSFORM_LOOPS);
const propertyOwnerSchema = z.object({
	kind: z.enum(['item', 'shot', 'advanced-layer']),
	id: z.string().min(1),
});
const numericPropertyKeyframeSchema = z.object({
	frame: frameSchema,
	value: finiteNumber,
	easing: easingSchema,
	hold: z.boolean().optional(),
	handleIn: z
		.object({x: finiteNumber.min(0).max(1), y: finiteNumber.min(-1).max(2)})
		.optional(),
	handleOut: z
		.object({x: finiteNumber.min(0).max(1), y: finiteNumber.min(-1).max(2)})
		.optional(),
});
export const propertyGraphSchema = z.object({
	version: z.literal(1),
	sets: z.record(
		z.string(),
		z.object({
			owner: propertyOwnerSchema,
			properties: z.record(
				z.string(),
				z.object({
					baseValue: finiteNumber,
					keyframes: z
						.array(numericPropertyKeyframeSchema)
						.max(MAX_KEYFRAMES_PER_ITEM),
				}),
			),
			loop: loopSchema,
			loopStartFrame: frameSchema.optional(),
			loopEndFrame: frameSchema.optional(),
			readOnly: z.boolean().optional(),
		}),
	),
	warnings: z
		.array(
			z.object({
				owner: propertyOwnerSchema,
				field: z.string(),
				message: z.string(),
			}),
		)
		.optional(),
});
const presetParametersSchema = z.record(
	z.string(),
	z.union([finiteNumber, z.string(), z.boolean()]),
);

const boneRigSchema: ZodType<BoneRig> = z.object({
	rootBoneId: z.string().min(1),
	bones: z.array(
		z.object({
			id: z.string().min(1),
			name: z.string().min(1),
			parentId: z.string().min(1).optional(),
			x: finiteNumber,
			y: finiteNumber,
			length: finiteNumber.min(0),
			rotation: finiteNumber,
			scaleX: finiteNumber,
			scaleY: finiteNumber,
			keyframes: z
				.array(
					z.object({
						frame: frameSchema,
						x: finiteNumber.optional(),
						y: finiteNumber.optional(),
						rotation: finiteNumber.optional(),
						scaleX: finiteNumber.optional(),
						scaleY: finiteNumber.optional(),
					}),
				)
				.max(MAX_KEYFRAMES_PER_ITEM)
				.optional(),
		}),
	),
});

const meshPointSchema = z.object({
	x: finiteNumber,
	y: finiteNumber,
});

const meshKeyframeSchema: ZodType<MeshKeyframe> = z.object({
	frame: frameSchema,
	points: z.array(meshPointSchema),
});

const meshGridSchema: ZodType<MeshGrid> = z.object({
	columns: z.number().int().min(2).max(32),
	rows: z.number().int().min(2).max(32),
	points: z.array(meshPointSchema),
	keyframes: z.array(meshKeyframeSchema).max(MAX_KEYFRAMES_PER_ITEM).optional(),
});

const curveHandleSchema = z.object({
	x: finiteNumber.min(0).max(1),
	y: finiteNumber.min(-1).max(2),
});

export const transformKeyframeSchema = z.object({
	frame: frameSchema,
	anchorX: finiteNumber.optional(),
	anchorY: finiteNumber.optional(),
	x: finiteNumber.optional(),
	y: finiteNumber.optional(),
	scaleX: finiteNumber.positive().optional(),
	scaleY: finiteNumber.positive().optional(),
	rotation: finiteNumber.optional(),
	opacity: finiteNumber.min(0).max(1).optional(),
	easing: easingSchema.optional(),
	hold: z.boolean().optional(),
	handleIn: curveHandleSchema.optional(),
	handleOut: curveHandleSchema.optional(),
});

export const cameraKeyframeSchema = z.object({
	frame: frameSchema,
	x: finiteNumber.optional(),
	y: finiteNumber.optional(),
	scale: finiteNumber.optional(),
	easing: easingSchema.optional(),
});

export const cameraAnimationSchema: ZodType<CameraAnimation> = z.object({
	keyframes: z.array(cameraKeyframeSchema).max(MAX_KEYFRAMES_PER_ITEM),
	loop: loopSchema.optional(),
	loopStartFrame: frameSchema.optional(),
	loopEndFrame: frameSchema.optional(),
	focalX: finiteNumber.optional(),
	focalY: finiteNumber.optional(),
});

export const imageMotionSchema: ZodType<ImageMotion> = z.object({
	transform: z
		.object({
			keyframes: z.array(transformKeyframeSchema).max(MAX_KEYFRAMES_PER_ITEM),
			animatedProperties: z
				.array(z.enum(TRANSFORM_ANIMATION_PROPERTIES))
				.optional(),
			x: finiteNumber.optional(),
			y: finiteNumber.optional(),
			scaleX: finiteNumber.positive().optional(),
			scaleY: finiteNumber.positive().optional(),
			rotation: finiteNumber.optional(),
			opacity: finiteNumber.min(0).max(1).optional(),
			loop: loopSchema.optional(),
			loopStartFrame: frameSchema.optional(),
			loopEndFrame: frameSchema.optional(),
			anchorX: finiteNumber.optional(),
			anchorY: finiteNumber.optional(),
		})
		.optional(),
	spriteStates: z
		.array(
			z.object({
				frame: frameSchema,
				assetId: z.string().min(1),
			}),
		)
		.max(MAX_KEYFRAMES_PER_ITEM)
		.optional(),
	preset: z
		.object({
			id: z.string().min(1),
			parameters: presetParametersSchema,
			seed: z.number().int().optional(),
		})
		.optional(),
	boneRig: boneRigSchema.optional(),
	meshGrid: meshGridSchema.optional(),
});

const shotTransitionSchema = z.discriminatedUnion('type', [
	z.object({type: z.literal('cut')}),
	z.object({
		type: z.literal('crossfade'),
		durationInFrames: positiveInt,
	}),
]);

export const shotSchema: ZodType<Shot> = z.object({
	id: z.string().min(1),
	name: z.string(),
	from: frameSchema,
	durationInFrames: positiveInt,
	layerTrackIds: z.array(z.string().min(1)),
	dialogueItemIds: z.array(z.string().min(1)),
	transitionOut: shotTransitionSchema.optional(),
	cameraMotion: cameraAnimationSchema.optional(),
	diagnostics: z.array(z.string()).optional(),
});

const boundsSchema = z.object({
	x: finiteNumber,
	y: finiteNumber,
	width: finiteNumber,
	height: finiteNumber,
});

const manualLayerPointSchema = z.object({
	x: finiteNumber,
	y: finiteNumber,
});

const manualLayerSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	semantic: z.enum(COMIC_LAYER_SEMANTICS),
	sourceAssetId: z.string().min(1),
	sourceItemId: z.string().min(1).optional(),
	sourceTrackId: z.string().min(1).optional(),
	shotId: z.string().min(1).optional(),
	sourceCanvas: z.object({
		width: positiveInt,
		height: positiveInt,
	}),
	bounds: boundsSchema,
	anchor: z
		.object({
			x: finiteNumber.min(0).max(1),
			y: finiteNumber.min(0).max(1),
		})
		.optional(),
	polygon: z.array(manualLayerPointSchema).min(3).optional(),
	maskAssetId: z.string().min(1).optional(),
	cutoutAssetId: z.string().min(1).optional(),
	cleanPlateAssetId: z.string().min(1).optional(),
	cutoutItemId: z.string().min(1).optional(),
	cutoutTrackId: z.string().min(1).optional(),
	cleanPlateItemId: z.string().min(1).optional(),
	cleanPlateTrackId: z.string().min(1).optional(),
	cleanPlateStatus: z.enum(CLEAN_PLATE_STATUSES).optional(),
	finalCompositionReady: z.boolean().optional(),
	visible: z.boolean().optional(),
	locked: z.boolean().optional(),
	opacity: finiteNumber.min(0).max(1).optional(),
	zIndex: z.number().int().optional(),
});

const manualLayersSchema = z.record(z.string().min(1), manualLayerSchema);

export const imageBlendModeSchema = z.enum(IMAGE_BLEND_MODES);
export const imageMaskModeSchema = z.enum(IMAGE_MASK_MODES);

const layerGroupSchema: ZodType<LayerGroup> = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	trackIds: z.array(z.string().min(1)),
	parentGroupId: z.string().min(1).optional(),
	visible: z.boolean(),
	locked: z.boolean(),
	collapsed: z.boolean(),
});

const adjustmentLayerSchema: ZodType<AdjustmentLayer> = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	targetTrackIds: z.array(z.string().min(1)),
	effects: z.object({
		brightness: finiteNumber,
		contrast: finiteNumber,
		saturation: finiteNumber,
		hue: finiteNumber,
		blur: finiteNumber.min(0),
	}),
	visible: z.boolean(),
	opacity: finiteNumber.min(0).max(1),
});

const bezierHandleSchema = z.object({
	x: finiteNumber,
	y: finiteNumber,
});

const penPathSchema: ZodType<PenPath> = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	closed: z.boolean(),
	anchors: z.array(
		z.object({
			x: finiteNumber,
			y: finiteNumber,
			inHandle: bezierHandleSchema.optional(),
			outHandle: bezierHandleSchema.optional(),
		}),
	),
	bounds: boundsSchema.optional(),
});

export const layerPackageSchema: ZodType<LayerPackage> = z.object({
	schemaVersion: z.literal(1),
	projectId: z.string().min(1),
	shotId: z.string().min(1),
	sourceUrl: remoteUrlSchema,
	canvas: z.object({
		width: positiveInt,
		height: positiveInt,
	}),
	layers: z
		.array(
			z.object({
				layerId: z.string().min(1),
				name: z.string(),
				semantic: z.enum(COMIC_LAYER_SEMANTICS),
				imageUrl: remoteUrlSchema,
				isCleanPlate: z.boolean().optional(),
				opacity: finiteNumber.min(0).max(1).optional(),
				zIndex: z.number().int(),
				visible: z.boolean(),
				bounds: boundsSchema,
				anchor: z.object({
					x: finiteNumber,
					y: finiteNumber,
				}),
				confidence: finiteNumber,
				motionPolicy: z.enum(MOTION_POLICIES),
			}),
		)
		.max(MAX_ITEMS),
	diagnostics: z.object({
		recompositionScore: finiteNumber,
		alphaHoleRatio: finiteNumber,
		edgeArtifactScore: finiteNumber,
		requiresFallback: z.boolean(),
		warnings: z.array(z.string()),
	}),
});

const trackSchema = z.looseObject({
	id: z.string(),
	items: z.array(z.string()),
	hidden: z.boolean(),
	muted: z.boolean(),
	name: z.string().optional(),
	shotId: z.string().optional(),
	semantic: z.string().optional(),
	role: z
		.enum(['source', 'clean-plate', 'cutout', 'dialogue', 'other'])
		.optional(),
});

const voiceProfileSchema = z.object({
	id: z.string().min(1),
	characterId: z.string().min(1),
	displayName: z.string().min(1).optional(),
	provider: z.enum(VOICE_PROFILE_PROVIDERS),
	voiceId: z.string().min(1),
	style: z.string().min(1).optional(),
	language: z.string().min(1).optional(),
	defaultForCharacter: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

export const projectBaseSchema: ZodType<UndoableState> = z.looseObject({
	schemaVersion: z.number().int().nonnegative().optional(),
	tracks: z.array(trackSchema).max(MAX_ITEMS),
	assets: z.record(
		z.string(),
		z.looseObject({
			id: z.string(),
			type: z.string(),
		}),
	),
	items: z.record(
		z.string(),
		z.looseObject({
			id: z.string(),
			type: z.string(),
			from: z.number(),
			durationInFrames: z.number(),
			blendMode: imageBlendModeSchema.optional(),
			maskAssetId: z.string().min(1).optional(),
			maskMode: imageMaskModeSchema.optional(),
		}),
	),
	fps: z.number().positive(),
	compositionWidth: z.number().positive(),
	compositionHeight: z.number().positive(),
	deletedAssets: z.array(
		z.looseObject({
			assetId: z.string(),
			remoteUrl: z.string().nullable(),
			remoteFileKey: z.string().nullable(),
		}),
	),
	shots: z.array(shotSchema).max(MAX_SHOTS).optional(),
	comicEditLayers: manualLayersSchema.optional(),
	voiceProfiles: z.record(z.string(), voiceProfileSchema).optional(),
	layerGroups: z.record(z.string(), layerGroupSchema).optional(),
	adjustmentLayers: z.record(z.string(), adjustmentLayerSchema).optional(),
	penPaths: z.record(z.string(), penPathSchema).optional(),
	propertyGraph: propertyGraphSchema.optional(),
}) as unknown as ZodType<UndoableState>;

export const cameraPresetIdSchema = z.enum(CAMERA_PRESET_IDS);
export const itemPresetIdSchema = z.enum(ITEM_PRESET_IDS);
