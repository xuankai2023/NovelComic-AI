import {describe, expect, it} from 'vitest';
import {expandCameraPreset, expandItemPreset, expandPreset} from './presets';

const rotations = (
	animation: ReturnType<typeof expandItemPreset>,
): number[] => {
	return animation.keyframes.flatMap((keyframe) => {
		return keyframe.rotation === undefined ? [] : [keyframe.rotation];
	});
};

describe('motion presets', () => {
	it('clamps camera, pan, breathing, float, and hair parameters', () => {
		const pushed = expandCameraPreset('camera-push', {
			durationInFrames: 90,
			parameters: {scale: 5},
		});
		expect(pushed.keyframes[0]?.scale).toBe(1);
		expect(pushed.keyframes.at(-1)?.scale).toBe(1.2);

		const pulled = expandCameraPreset('camera-pull', {
			durationInFrames: 90,
			parameters: {scale: 0.2},
		});
		expect(pulled.keyframes[0]?.scale).toBe(1);
		expect(pulled.keyframes.at(-1)?.scale).toBe(1);

		expect(
			expandCameraPreset('pan-left', {
				durationInFrames: 90,
				parameters: {distance: 9999},
			}).keyframes.at(-1)?.x,
		).toBe(-400);
		expect(
			expandCameraPreset('pan-right', {
				durationInFrames: 90,
				parameters: {distance: -20},
			}).keyframes.at(-1)?.x,
		).toBe(0);

		const breathing = expandItemPreset('breathing', {
			durationInFrames: 90,
			parameters: {scale: 4},
		});
		expect(breathing.keyframes[1]?.scaleX).toBe(1.03);
		expect(breathing.keyframes[1]?.scaleY).toBe(1.03);
		expect(
			expandItemPreset('breathing', {
				durationInFrames: 90,
				parameters: {scale: 0.4},
			}).keyframes[1]?.scaleX,
		).toBe(1);

		const floating = expandItemPreset('float', {
			durationInFrames: 120,
			parameters: {amplitude: 500},
			seed: 3,
		});
		const peak = floating.keyframes[1]?.y ?? 0;
		expect(peak).toBeLessThan(0);
		expect(Math.abs(peak)).toBeLessThanOrEqual(40);

		const hair = expandItemPreset('hair-sway', {
			durationInFrames: 90,
			parameters: {rotation: 40},
			seed: 2,
		});
		expect(hair.keyframes[1]?.rotation).toBeGreaterThanOrEqual(1);
		expect(hair.keyframes[1]?.rotation).toBeLessThanOrEqual(3);
		expect(hair.keyframes[0]?.rotation).toBe(0);
		expect(hair.keyframes.at(-1)?.rotation).toBe(0);
		expect(Math.abs(hair.keyframes[1]?.rotation ?? 0)).toBeGreaterThanOrEqual(
			1,
		);
		for (const rotation of rotations(hair)) {
			expect(Math.abs(rotation)).toBeLessThanOrEqual(3);
		}
	});

	it('supports light, medium, and heavy intensity profiles', () => {
		const lightHair = expandItemPreset('hair-sway', {
			durationInFrames: 90,
			parameters: {intensity: 'light'},
			seed: 1,
		});
		const mediumHair = expandItemPreset('hair-sway', {
			durationInFrames: 90,
			parameters: {intensity: 'medium'},
			seed: 1,
		});
		const heavyHair = expandItemPreset('hair-sway', {
			durationInFrames: 90,
			parameters: {intensity: 'heavy'},
			seed: 1,
		});

		expect(Math.abs(lightHair.keyframes[1]?.rotation ?? 0)).toBeLessThan(
			Math.abs(mediumHair.keyframes[1]?.rotation ?? 0),
		);
		expect(Math.abs(mediumHair.keyframes[1]?.rotation ?? 0)).toBeLessThan(
			Math.abs(heavyHair.keyframes[1]?.rotation ?? 0),
		);

		const lightCamera = expandCameraPreset('camera-push', {
			durationInFrames: 90,
			parameters: {intensity: 'light'},
		});
		const heavyCamera = expandCameraPreset('camera-push', {
			durationInFrames: 90,
			parameters: {intensity: 'heavy'},
		});
		expect(lightCamera.keyframes.at(-1)?.scale).toBe(1.04);
		expect(heavyCamera.keyframes.at(-1)?.scale).toBe(1.12);
	});

	it('rejects unknown presets', () => {
		expect(() => expandPreset('parallax', {durationInFrames: 30})).toThrow(
			/Unknown motion preset: parallax/,
		);
	});

	it('rejects blink and mouth-flap because they need sprite states', () => {
		expect(() =>
			expandPreset('blink', {durationInFrames: 30, seed: 1}),
		).toThrow(/blink requires sprite state assets/);
		expect(() =>
			expandPreset('mouth-flap', {durationInFrames: 30, seed: 1}),
		).toThrow(/mouth-flap requires sprite state assets/);
	});

	it('is deterministic for the same seed and changes with a different seed', () => {
		const options = {durationInFrames: 120, parameters: {amplitude: 16}};
		expect(expandItemPreset('float', {...options, seed: 4})).toEqual(
			expandItemPreset('float', {...options, seed: 4}),
		);
		expect(expandItemPreset('float', {...options, seed: 4})).not.toEqual(
			expandItemPreset('float', {...options, seed: 5}),
		);

		const hairOptions = {durationInFrames: 96, parameters: {rotation: 2}};
		expect(expandItemPreset('hair-sway', {...hairOptions, seed: 8})).toEqual(
			expandItemPreset('hair-sway', {...hairOptions, seed: 8}),
		);
		expect(
			expandItemPreset('hair-sway', {...hairOptions, seed: 8}),
		).not.toEqual(expandItemPreset('hair-sway', {...hairOptions, seed: 9}));
	});
});
