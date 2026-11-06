export const EASING_NAMES = [
	'linear',
	'ease-in',
	'ease-out',
	'ease-in-out',
] as const;

export type EasingName = (typeof EASING_NAMES)[number];

export type CurveHandle = {
	x: number;
	y: number;
};

export const TRANSFORM_LOOPS = ['none', 'repeat', 'ping-pong'] as const;

export type TransformLoop = (typeof TRANSFORM_LOOPS)[number];

export type TransformKeyframe = {
	frame: number;
	anchorX?: number;
	anchorY?: number;
	x?: number;
	y?: number;
	scaleX?: number;
	scaleY?: number;
	rotation?: number;
	opacity?: number;
	easing?: EasingName;
	hold?: boolean;
	handleIn?: CurveHandle;
	handleOut?: CurveHandle;
};

export const TRANSFORM_ANIMATION_PROPERTIES = [
	'anchorPoint',
	'position',
	'scale',
	'rotation',
	'opacity',
] as const;

export type TransformAnimationProperty =
	(typeof TRANSFORM_ANIMATION_PROPERTIES)[number];

export type TransformAnimation = {
	keyframes: TransformKeyframe[];
	animatedProperties?: TransformAnimationProperty[];
	x?: number;
	y?: number;
	scaleX?: number;
	scaleY?: number;
	rotation?: number;
	opacity?: number;
	loop?: TransformLoop;
	loopStartFrame?: number;
	loopEndFrame?: number;
	anchorX?: number;
	anchorY?: number;
};

export type SpriteState = {
	frame: number;
	assetId: string;
};

export type MotionPreset = {
	id: string;
	parameters: Record<string, number | string | boolean>;
	seed?: number;
};

export type ImageMotion = {
	transform?: TransformAnimation;
	spriteStates?: SpriteState[];
	preset?: MotionPreset;
	boneRig?: BoneRig;
	meshGrid?: MeshGrid;
};

export type CameraKeyframe = {
	frame: number;
	x?: number;
	y?: number;
	scale?: number;
	easing?: EasingName;
};

export type CameraAnimation = {
	keyframes: CameraKeyframe[];
	loop?: TransformLoop;
	loopStartFrame?: number;
	loopEndFrame?: number;
	focalX?: number;
	focalY?: number;
};

export type EvaluatedImagePose = {
	assetId: string;
	left: number;
	top: number;
	width: number;
	height: number;
	rotation: number;
	opacity: number;
	anchorX: number;
	anchorY: number;
};
import type {BoneRig, MeshGrid} from '../advanced/types';
