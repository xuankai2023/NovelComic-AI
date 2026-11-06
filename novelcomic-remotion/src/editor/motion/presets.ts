import {intensityValue} from './intensity';
import type {CameraAnimation, TransformAnimation} from './types';

export const CAMERA_PRESET_IDS = [
	'camera-push',
	'camera-pull',
	'pan-left',
	'pan-right',
] as const;

export const ITEM_PRESET_IDS = ['breathing', 'float', 'hair-sway'] as const;

export const SPRITE_PRESET_IDS = ['blink', 'mouth-flap'] as const;

export type CameraPresetId = (typeof CAMERA_PRESET_IDS)[number];
export type ItemPresetId = (typeof ITEM_PRESET_IDS)[number];

export type ExpandPresetOptions = {
	durationInFrames: number;
	parameters?: Record<string, number | string | boolean>;
	seed?: number;
};

const CAMERA_SCALE_MIN = 1;
const CAMERA_SCALE_MAX = 1.2;
const PAN_DISTANCE_MAX = 400;
const BREATHING_SCALE_MIN = 1;
const BREATHING_SCALE_MAX = 1.03;
const HAIR_ROTATION_MIN = 1;
const HAIR_ROTATION_MAX = 3;
const FLOAT_AMPLITUDE_MAX = 40;

const clamp = (value: number, min: number, max: number): number => {
	return Math.min(max, Math.max(min, value));
};

const readNumber = (
	parameters: ExpandPresetOptions['parameters'],
	key: string,
	fallback: number,
): number => {
	const value = parameters?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const resolveDuration = (durationInFrames: number): number => {
	if (!Number.isFinite(durationInFrames)) {
		return 1;
	}

	return Math.max(1, Math.round(durationInFrames));
};

const resolvePeriod = (requested: number, durationInFrames: number): number => {
	const maxPeriod = Math.max(2, durationInFrames - 1);
	if (!Number.isFinite(requested)) {
		return Math.min(maxPeriod, 2);
	}

	return Math.max(2, Math.min(maxPeriod, Math.round(requested)));
};

const unitFromSeed = (seed: number | undefined): number => {
	const normalized = Number.isFinite(seed) ? Math.trunc(seed as number) : 0;
	let state = Math.imul(normalized + 0x6d2b79f5, 0x9e3779b1);
	state ^= state >>> 16;
	state = Math.imul(state, 0x7feb352d);
	state ^= state >>> 15;
	return (state >>> 0) / 4294967296;
};

const isCameraPresetId = (presetId: string): presetId is CameraPresetId => {
	return (CAMERA_PRESET_IDS as readonly string[]).includes(presetId);
};

const isItemPresetId = (presetId: string): presetId is ItemPresetId => {
	return (ITEM_PRESET_IDS as readonly string[]).includes(presetId);
};

export const expandCameraPreset = (
	presetId: CameraPresetId,
	options: ExpandPresetOptions,
): CameraAnimation => {
	const durationInFrames = resolveDuration(options.durationInFrames);
	const endFrame = durationInFrames - 1;

	if (presetId === 'camera-push' || presetId === 'camera-pull') {
		const scale = clamp(
			readNumber(
				options.parameters,
				'scale',
				intensityValue(
					{light: 1.04, medium: 1.08, heavy: 1.12},
					options.parameters?.intensity,
				),
			),
			CAMERA_SCALE_MIN,
			CAMERA_SCALE_MAX,
		);
		const startScale = presetId === 'camera-pull' ? scale : 1;
		const endScale = presetId === 'camera-push' ? scale : 1;

		return {
			keyframes: [
				{frame: 0, x: 0, y: 0, scale: startScale, easing: 'linear'},
				{
					frame: endFrame,
					x: 0,
					y: 0,
					scale: endScale,
					easing: 'ease-in-out',
				},
			],
		};
	}

	const distance = clamp(
		readNumber(
			options.parameters,
			'distance',
			intensityValue(
				{light: 40, medium: 80, heavy: 120},
				options.parameters?.intensity,
			),
		),
		0,
		PAN_DISTANCE_MAX,
	);
	const direction = presetId === 'pan-left' ? -1 : 1;

	return {
		keyframes: [
			{frame: 0, x: 0, y: 0, scale: 1, easing: 'linear'},
			{
				frame: endFrame,
				x: direction * distance,
				y: 0,
				scale: 1,
				easing: 'ease-in-out',
			},
		],
	};
};

export const expandItemPreset = (
	presetId: ItemPresetId,
	options: ExpandPresetOptions,
): TransformAnimation => {
	const durationInFrames = resolveDuration(options.durationInFrames);
	const seedUnit = unitFromSeed(options.seed);

	if (presetId === 'breathing') {
		const scale = clamp(
			readNumber(
				options.parameters,
				'scale',
				intensityValue(
					{light: 1.01, medium: 1.02, heavy: 1.03},
					options.parameters?.intensity,
				),
			),
			BREATHING_SCALE_MIN,
			BREATHING_SCALE_MAX,
		);
		const period = resolvePeriod(
			readNumber(options.parameters, 'period', 90),
			durationInFrames,
		);
		const half = Math.round(period / 2);

		return {
			keyframes: [
				{frame: 0, scaleX: 1, scaleY: 1, easing: 'ease-in-out'},
				{frame: half, scaleX: scale, scaleY: scale, easing: 'ease-in-out'},
				{frame: period, scaleX: 1, scaleY: 1, easing: 'ease-in-out'},
			],
			loop: 'ping-pong',
			loopStartFrame: 0,
			loopEndFrame: period,
			anchorX: 0.5,
			anchorY: 0.5,
		};
	}

	if (presetId === 'float') {
		const amplitude = clamp(
			readNumber(
				options.parameters,
				'amplitude',
				intensityValue(
					{light: 6, medium: 12, heavy: 24},
					options.parameters?.intensity,
				),
			),
			0,
			FLOAT_AMPLITUDE_MAX,
		);
		const period = resolvePeriod(
			readNumber(options.parameters, 'period', 60),
			durationInFrames,
		);
		const half = Math.round(period / 2);
		const peak = -(amplitude * (0.8 + 0.2 * seedUnit));

		return {
			keyframes: [
				{frame: 0, y: 0, easing: 'ease-in-out'},
				{frame: half, y: peak, easing: 'ease-in-out'},
				{frame: period, y: 0, easing: 'ease-in-out'},
			],
			loop: 'ping-pong',
			loopStartFrame: 0,
			loopEndFrame: period,
			anchorX: 0.5,
			anchorY: 0.5,
		};
	}

	const rotation = clamp(
		readNumber(
			options.parameters,
			'rotation',
			intensityValue(
				{light: 1, medium: 2, heavy: 3},
				options.parameters?.intensity,
			),
		),
		HAIR_ROTATION_MIN,
		HAIR_ROTATION_MAX,
	);
	const period = resolvePeriod(
		readNumber(options.parameters, 'period', 48),
		durationInFrames,
	);
	const half = Math.round(period / 2);
	const peak = rotation * (0.75 + 0.25 * seedUnit);

	return {
		keyframes: [
			{frame: 0, rotation: 0, easing: 'ease-in-out'},
			{frame: half, rotation: peak, easing: 'ease-in-out'},
			{frame: period, rotation: 0, easing: 'ease-in-out'},
		],
		loop: 'ping-pong',
		loopStartFrame: 0,
		loopEndFrame: period,
		anchorX: 0.5,
		anchorY: 0,
	};
};

export const expandPreset = (
	presetId: string,
	options: ExpandPresetOptions,
): CameraAnimation | TransformAnimation => {
	if ((SPRITE_PRESET_IDS as readonly string[]).includes(presetId)) {
		throw new Error(`${presetId} requires sprite state assets`);
	}

	if (isCameraPresetId(presetId)) {
		return expandCameraPreset(presetId, options);
	}

	if (isItemPresetId(presetId)) {
		return expandItemPreset(presetId, options);
	}

	throw new Error(`Unknown motion preset: ${presetId}`);
};
