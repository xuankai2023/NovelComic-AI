/** Serializable Camera Raw controls. Values are intentionally scalar and
 * JSON-friendly so the same settings can be evaluated in a worker or during
 * Remotion rendering. */

export type CameraRawCurveChannel = 'rgb' | 'red' | 'green' | 'blue';
export type CameraRawCurve = {
	channel: CameraRawCurveChannel;
	points: Array<{x: number; y: number}>;
};
export type CameraRawMixer = {
	red: {hue: number; saturation: number; luminance: number};
	orange: {hue: number; saturation: number; luminance: number};
	yellow: {hue: number; saturation: number; luminance: number};
	green: {hue: number; saturation: number; luminance: number};
	cyan: {hue: number; saturation: number; luminance: number};
	blue: {hue: number; saturation: number; luminance: number};
	purple: {hue: number; saturation: number; luminance: number};
	magenta: {hue: number; saturation: number; luminance: number};
};
export type CameraRawWheel = {hue: number; saturation: number; luminance: number};
export type CameraRawSettings = {
	whiteBalance: 'custom' | 'auto';
	temperature: number;
	tint: number;
	exposure: number;
	contrast: number;
	highlights: number;
	shadows: number;
	whites: number;
	blacks: number;
	vibrance: number;
	saturation: number;
	texture: number;
	clarity: number;
	dehaze: number;
	curve: {
		shadows: number;
		darks: number;
		lights: number;
		highlights: number;
		shadowSplit: number;
		darkSplit: number;
		lightSplit: number;
		channels: CameraRawCurve[];
	};
	mixer: CameraRawMixer;
	grading: {
		shadows: CameraRawWheel;
		midtones: CameraRawWheel;
		highlights: CameraRawWheel;
		global: CameraRawWheel;
		blending: number;
		balance: number;
	};
	detail: {
		sharpenAmount: number;
		sharpenRadius: number;
		sharpenDetail: number;
		sharpenMasking: number;
		noiseLuminance: number;
		noiseColor: number;
	};
	optics: {
		removeChromaticAberration: boolean;
		distortion: number;
		purpleAmount: number;
		greenAmount: number;
		vignetteAmount: number;
		vignetteMidpoint: number;
	};
	geometry: {
		vertical: number;
		horizontal: number;
		rotate: number;
		aspect: number;
		scale: number;
		offsetX: number;
		offsetY: number;
		constrainCrop: boolean;
	};
	bloom: {amount: number; radius: number; warmth: number};
	vignette: {amount: number; midpoint: number; roundness: number; feather: number};
	grain: {amount: number; size: number; roughness: number; seed: number};
	dither: {enabled: boolean; style: 'floyd-steinberg' | 'atkinson' | 'bayer'; levels: number; pixelSize: number};
};

const curve = (channel: CameraRawCurveChannel): CameraRawCurve => ({channel, points: [{x: 0, y: 0}, {x: 1, y: 1}]});
const wheel = (): CameraRawWheel => ({hue: 0, saturation: 0, luminance: 0});
const mixerChannel = () => ({hue: 0, saturation: 0, luminance: 0});

export const createDefaultCameraRawSettings = (): CameraRawSettings => ({
	whiteBalance: 'custom', temperature: 0, tint: 0, exposure: 0, contrast: 0,
	highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0, saturation: 0,
	texture: 0, clarity: 0, dehaze: 0,
	curve: {shadows: 0, darks: 0, lights: 0, highlights: 0, shadowSplit: 25, darkSplit: 50, lightSplit: 75, channels: [curve('rgb'), curve('red'), curve('green'), curve('blue')]},
	mixer: {red: mixerChannel(), orange: mixerChannel(), yellow: mixerChannel(), green: mixerChannel(), cyan: mixerChannel(), blue: mixerChannel(), purple: mixerChannel(), magenta: mixerChannel()},
	grading: {shadows: wheel(), midtones: wheel(), highlights: wheel(), global: wheel(), blending: 50, balance: 0},
	detail: {sharpenAmount: 0, sharpenRadius: 1, sharpenDetail: 25, sharpenMasking: 0, noiseLuminance: 0, noiseColor: 0},
	optics: {removeChromaticAberration: false, distortion: 0, purpleAmount: 0, greenAmount: 0, vignetteAmount: 0, vignetteMidpoint: 50},
	geometry: {vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 0, offsetX: 0, offsetY: 0, constrainCrop: false},
	bloom: {amount: 0, radius: 8, warmth: 0},
	vignette: {amount: 0, midpoint: 50, roundness: 0, feather: 50},
	grain: {amount: 0, size: 25, roughness: 50, seed: 0},
	dither: {enabled: false, style: 'floyd-steinberg', levels: 8, pixelSize: 1},
});

const clamp = (value: number, min: number, max: number, fallback = min) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const normalizeWheel = (value: CameraRawWheel): CameraRawWheel => ({hue: clamp(value.hue, -180, 180), saturation: clamp(value.saturation, -100, 100), luminance: clamp(value.luminance, -100, 100)});
const normalizeCurve = (value: CameraRawCurve): CameraRawCurve => ({channel: value.channel, points: value.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).map((point) => ({x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1)})).sort((a, b) => a.x - b.x)});

export const normalizeCameraRawSettings = (input: Partial<CameraRawSettings> | undefined): CameraRawSettings => {
	const base = createDefaultCameraRawSettings();
	const value = {...base, ...(input ?? {})} as CameraRawSettings;
	return {
		...value,
		temperature: clamp(value.temperature, -100, 100), tint: clamp(value.tint, -100, 100), exposure: clamp(value.exposure, -5, 5), contrast: clamp(value.contrast, -100, 100),
		highlights: clamp(value.highlights, -100, 100), shadows: clamp(value.shadows, -100, 100), whites: clamp(value.whites, -100, 100), blacks: clamp(value.blacks, -100, 100), vibrance: clamp(value.vibrance, -100, 100), saturation: clamp(value.saturation, -100, 100), texture: clamp(value.texture, -100, 100), clarity: clamp(value.clarity, -100, 100), dehaze: clamp(value.dehaze, -100, 100),
		curve: {...base.curve, ...(value.curve ?? {}), channels: (value.curve?.channels ?? base.curve.channels).map(normalizeCurve)},
		mixer: Object.fromEntries(Object.keys(base.mixer).map((key) => [key, normalizeWheel((value.mixer as Record<string, CameraRawWheel> | undefined)?.[key] ?? mixerChannel())])) as CameraRawMixer,
		grading: {...base.grading, ...(value.grading ?? {}), shadows: normalizeWheel(value.grading?.shadows ?? base.grading.shadows), midtones: normalizeWheel(value.grading?.midtones ?? base.grading.midtones), highlights: normalizeWheel(value.grading?.highlights ?? base.grading.highlights), global: normalizeWheel(value.grading?.global ?? base.grading.global), blending: clamp(value.grading?.blending ?? 50, 0, 100), balance: clamp(value.grading?.balance ?? 0, -100, 100)},
		detail: {...base.detail, ...(value.detail ?? {}), sharpenAmount: clamp(value.detail?.sharpenAmount ?? 0, 0, 150), sharpenRadius: clamp(value.detail?.sharpenRadius ?? 1, 0.1, 20), sharpenDetail: clamp(value.detail?.sharpenDetail ?? 25, 0, 100), sharpenMasking: clamp(value.detail?.sharpenMasking ?? 0, 0, 100), noiseLuminance: clamp(value.detail?.noiseLuminance ?? 0, 0, 100), noiseColor: clamp(value.detail?.noiseColor ?? 0, 0, 100)},
		optics: {...base.optics, ...(value.optics ?? {}), distortion: clamp(value.optics?.distortion ?? 0, -100, 100), purpleAmount: clamp(value.optics?.purpleAmount ?? 0, 0, 100), greenAmount: clamp(value.optics?.greenAmount ?? 0, 0, 100), vignetteAmount: clamp(value.optics?.vignetteAmount ?? 0, -100, 100), vignetteMidpoint: clamp(value.optics?.vignetteMidpoint ?? 50, 0, 100)},
		geometry: {...base.geometry, ...(value.geometry ?? {}), vertical: clamp(value.geometry?.vertical ?? 0, -100, 100), horizontal: clamp(value.geometry?.horizontal ?? 0, -100, 100), rotate: clamp(value.geometry?.rotate ?? 0, -45, 45), aspect: clamp(value.geometry?.aspect ?? 0, -100, 100), scale: clamp(value.geometry?.scale ?? 0, -100, 100), offsetX: clamp(value.geometry?.offsetX ?? 0, -100, 100), offsetY: clamp(value.geometry?.offsetY ?? 0, -100, 100)},
		bloom: {...base.bloom, ...(value.bloom ?? {}), amount: clamp(value.bloom?.amount ?? 0, 0, 100), radius: clamp(value.bloom?.radius ?? 8, 0, 64), warmth: clamp(value.bloom?.warmth ?? 0, -100, 100)},
		vignette: {...base.vignette, ...(value.vignette ?? {}), amount: clamp(value.vignette?.amount ?? 0, -100, 100), midpoint: clamp(value.vignette?.midpoint ?? 50, 0, 100), roundness: clamp(value.vignette?.roundness ?? 0, -100, 100), feather: clamp(value.vignette?.feather ?? 50, 1, 100)},
		grain: {...base.grain, ...(value.grain ?? {}), amount: clamp(value.grain?.amount ?? 0, 0, 100), size: clamp(value.grain?.size ?? 25, 1, 100), roughness: clamp(value.grain?.roughness ?? 50, 0, 100), seed: Number.isFinite(value.grain?.seed) ? Math.trunc(value.grain!.seed) : 0},
		dither: {...base.dither, ...(value.dither ?? {}), levels: Math.round(clamp(value.dither?.levels ?? 8, 2, 16)), pixelSize: Math.round(clamp(value.dither?.pixelSize ?? 1, 1, 32))},
	};
};

export const isCameraRawIdentity = (settings: CameraRawSettings): boolean => JSON.stringify(normalizeCameraRawSettings(settings)) === JSON.stringify(createDefaultCameraRawSettings());
