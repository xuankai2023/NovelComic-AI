export const MOTION_INTENSITIES = ['light', 'medium', 'heavy'] as const;

export type MotionIntensity = (typeof MOTION_INTENSITIES)[number];

export const DEFAULT_MOTION_INTENSITY: MotionIntensity = 'medium';

const INTENSITY_MULTIPLIERS: Record<MotionIntensity, number> = {
	light: 0.5,
	medium: 1,
	heavy: 1.5,
};

export const isMotionIntensity = (
	value: string | undefined,
): value is MotionIntensity => {
	return (
		value !== undefined &&
		(MOTION_INTENSITIES as readonly string[]).includes(value)
	);
};

export const resolveMotionIntensity = (
	value: string | number | boolean | undefined,
): MotionIntensity => {
	return typeof value === 'string' && isMotionIntensity(value)
		? value
		: DEFAULT_MOTION_INTENSITY;
};

export const intensityMultiplier = (
	value: string | number | boolean | undefined,
): number => {
	return INTENSITY_MULTIPLIERS[resolveMotionIntensity(value)];
};

export const intensityValue = (
	values: Record<MotionIntensity, number>,
	intensity: string | number | boolean | undefined,
): number => {
	return values[resolveMotionIntensity(intensity)];
};
