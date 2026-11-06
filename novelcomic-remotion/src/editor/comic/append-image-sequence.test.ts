import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {expandCameraPreset} from '../motion/presets';
import {appendImageSequence, panelIds} from './append-image-sequence';
import {ComicEditorError} from './errors';
import {
	PANEL_BLUR_RADIUS_PX,
	PANEL_DIM_OPACITY,
	panelFitIds,
} from './panel-fit';

const hosts = ['cdn.example.com'];

describe('appendImageSequence', () => {
	it('lays images out in order, fits both orientations, and expands the camera preset', () => {
		const project = createComicProject();
		const next = appendImageSequence(project, {
			allowedHosts: hosts,
			images: [
				{
					shotId: 'wide',
					url: 'https://cdn.example.com/wide.png',
					width: 1920,
					height: 1080,
					durationInFrames: 30,
					cameraPresetId: 'camera-push',
					seed: 7,
				},
				{
					shotId: 'tall',
					url: 'https://cdn.example.com/tall.png',
					width: 800,
					height: 1600,
					durationInFrames: 45,
				},
				{
					shotId: 'again',
					url: 'https://cdn.example.com/wide.png',
					width: 1920,
					height: 1080,
					durationInFrames: 60,
				},
			],
		});

		expect(
			next.shots?.map((shot) => [shot.id, shot.from, shot.durationInFrames]),
		).toEqual([
			['wide', 0, 30],
			['tall', 30, 45],
			['again', 75, 60],
		]);
		expect(next.items[panelIds('wide').itemId]).toMatchObject({
			left: 0,
			top: 656,
			width: 1080,
			height: 608,
		});
		expect(next.items[panelIds('tall').itemId]).toMatchObject({
			left: 60,
			top: 0,
			width: 960,
			height: 1920,
		});
		expect(next.shots?.[0]?.cameraMotion).toEqual({
			...expandCameraPreset('camera-push', {durationInFrames: 30, seed: 7}),
			focalX: 540,
			focalY: 960,
		});
		expect(project.tracks).toEqual([]);
		expect(project.shots).toEqual([]);
	});

	it('sizes a landscape page as 16:9 before placing the crop', () => {
		const project = createComicProject({
			compositionWidth: 1080,
			compositionHeight: 1920,
		});
		const next = appendImageSequence(project, {
			allowedHosts: hosts,
			compositionWidth: 1920,
			compositionHeight: 1080,
			panelFitPolicy: 'blurred-background-contain',
			blurRadiusPx: PANEL_BLUR_RADIUS_PX,
			dimOpacity: PANEL_DIM_OPACITY,
			images: [
				{
					shotId: 'wide',
					url: 'https://cdn.example.com/wide.png',
					width: 1505,
					height: 483,
					durationInFrames: 30,
				},
			],
		});
		const foreground = next.items[panelFitIds('wide').foregroundItemId];

		expect(next.compositionWidth).toBe(1920);
		expect(next.compositionHeight).toBe(1080);
		expect(foreground).toMatchObject({
			fit: 'contain',
			width: 1920,
		});
		expect(foreground?.top).toBeGreaterThan(0);
		expect((foreground?.top ?? 0) + (foreground?.height ?? 0)).toBeLessThanOrEqual(1080);
	});

	it('replays the same shot ids without adding tracks', () => {
		const images = [
			{
				shotId: 'wide',
				url: 'https://cdn.example.com/wide.png',
				width: 1920,
				height: 1080,
				durationInFrames: 30,
			},
			{
				shotId: 'tall',
				url: 'https://cdn.example.com/tall.png',
				width: 800,
				height: 1600,
				durationInFrames: 45,
			},
		];
		const first = appendImageSequence(createComicProject(), {
			allowedHosts: hosts,
			images,
		});
		const second = appendImageSequence(first, {
			allowedHosts: hosts,
			images: [
				images[0],
				{
					...images[1],
					url: 'https://cdn.example.com/tall-2.png',
					durationInFrames: 50,
				},
			],
		});

		expect(second.tracks).toHaveLength(first.tracks.length);
		expect(second.shots).toHaveLength(2);
		expect(second.assets[panelIds('tall').assetId]).toMatchObject({
			remoteUrl: 'https://cdn.example.com/tall-2.png',
		});
		expect(second.shots?.[1]?.from).toBe(30);
		expect(second.shots?.[1]?.durationInFrames).toBe(50);
		expect(Object.keys(first.assets)).toHaveLength(2);
	});

	it('rejects an invalid URL before writing any image', () => {
		const project = createComicProject();
		const snapshot = structuredClone(project);
		expect(() => {
			appendImageSequence(project, {
				allowedHosts: hosts,
				images: [
					{
						shotId: 'ok',
						url: 'https://cdn.example.com/ok.png',
						width: 100,
						height: 100,
						durationInFrames: 10,
					},
					{
						shotId: 'bad',
						url: 'https://127.0.0.1/secret.png',
						width: 100,
						height: 100,
						durationInFrames: 10,
					},
				],
			});
		}).toThrow(ComicEditorError);
		expect(() => {
			appendImageSequence(project, {
				allowedHosts: hosts,
				images: [
					{
						shotId: 'bad',
						url: 'http://cdn.example.com/plain.png',
						width: 100,
						height: 100,
						durationInFrames: 10,
					},
				],
			});
		}).toThrow(/HTTPS is required/);
		expect(project).toEqual(snapshot);
	});

	it('writes a contain foreground and a cover background for a wide panel', () => {
		const next = appendImageSequence(createComicProject(), {
			allowedHosts: hosts,
			panelFitPolicy: 'blurred-background-contain',
			images: [
				{
					shotId: 'wide',
					url: 'https://cdn.example.com/wide.png',
					width: 1920,
					height: 1080,
					durationInFrames: 30,
				},
			],
		});
		const ids = panelFitIds('wide');
		expect(next.tracks.map((track) => track.id)).toEqual([
			ids.foregroundTrackId,
			ids.backgroundTrackId,
		]);
		expect(next.assets[ids.assetId]).toMatchObject({
			remoteUrl: 'https://cdn.example.com/wide.png',
		});
		expect(Object.keys(next.assets)).toEqual([ids.assetId]);
		expect(next.items[ids.foregroundItemId]).toMatchObject({
			assetId: ids.assetId,
			fit: 'contain',
			role: 'panel-foreground',
			left: 0,
			top: 656,
			width: 1080,
			height: 608,
		});
		expect(next.items[ids.foregroundItemId]).not.toHaveProperty('blurRadiusPx');
		expect(next.items[ids.backgroundItemId]).toMatchObject({
			assetId: ids.assetId,
			fit: 'cover',
			role: 'panel-background',
			left: -1166,
			top: 0,
			width: 3413,
			height: 1920,
			blurRadiusPx: PANEL_BLUR_RADIUS_PX,
			dimOpacity: PANEL_DIM_OPACITY,
		});
		const foreground = next.items[ids.foregroundItemId];
		expect(foreground.left).toBeGreaterThanOrEqual(0);
		expect(foreground.top).toBeGreaterThanOrEqual(0);
		expect(foreground.left + foreground.width).toBeLessThanOrEqual(1080);
		expect(foreground.top + foreground.height).toBeLessThanOrEqual(1920);

		const replay = appendImageSequence(next, {
			allowedHosts: hosts,
			panelFitPolicy: 'blurred-background-contain',
			images: [
				{
					shotId: 'wide',
					url: 'https://cdn.example.com/wide.png',
					width: 1920,
					height: 1080,
					durationInFrames: 30,
				},
			],
		});
		expect(replay.tracks).toHaveLength(2);
		expect(replay.items[ids.foregroundItemId]).toMatchObject({
			fit: 'contain',
		});
	});
});
