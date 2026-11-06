import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {appendImageSequence} from './append-image-sequence';
import {COMIC_ERROR_CODES, ComicEditorError} from './errors';
import {importLayers, restoreL0} from './import-layers';
import {BLURRED_BACKGROUND_CONTAIN} from './panel-fit';
import type {ComicLayer, LayerPackage} from './types';
import {upsertShot} from './upsert-shot';

const hosts = ['cdn.test'];

const layer = (
	semantic: ComicLayer['semantic'],
	zIndex: number,
	bounds: ComicLayer['bounds'] = {x: 0, y: 0, width: 100, height: 100},
	visible = true,
): ComicLayer => {
	return {
		layerId: semantic,
		name: semantic,
		semantic,
		imageUrl: `https://cdn.test/${semantic}.png`,
		zIndex,
		visible,
		bounds,
		anchor: semantic === 'body' ? {x: 0.2, y: 0.8} : {x: 0.5, y: 0.5},
		confidence: 0.9,
		motionPolicy: 'subtle',
	};
};

const pack = (overrides?: Partial<LayerPackage>): LayerPackage => {
	return {
		schemaVersion: 1,
		projectId: 'project-1',
		shotId: 'shot-1',
		sourceUrl: 'https://cdn.test/source.png',
		canvas: {width: 1000, height: 2000},
		layers: [
			layer('background', 0, {x: 100, y: 200, width: 300, height: 400}),
			layer('body', 10),
			layer('mouth-open', 18),
			layer('mouth-half', 19),
			layer('mouth-closed', 20),
			layer('eye-closed', 25),
			layer('eye-open', 30),
			layer('foreground', 40, {x: 0, y: 0, width: 80, height: 80}, false),
		],
		diagnostics: {
			recompositionScore: 0.2,
			alphaHoleRatio: 0.01,
			edgeArtifactScore: 0.03,
			requiresFallback: false,
			warnings: ['alpha-hole'],
		},
		...overrides,
	};
};

const projectWithShot = () => {
	return upsertShot(
		createComicProject({compositionWidth: 500, compositionHeight: 1000}),
		{shotId: 'shot-1', durationInFrames: 90},
	);
};

describe('importLayers', () => {
	it('keeps the input unchanged when fallback or a remote URL is rejected', () => {
		const project = projectWithShot();
		const snapshot = structuredClone(project);
		expect(() => {
			importLayers(
				project,
				pack({
					diagnostics: {...pack().diagnostics, requiresFallback: true},
				}),
			);
		}).toThrow(ComicEditorError);
		try {
			importLayers(
				project,
				pack({
					diagnostics: {...pack().diagnostics, requiresFallback: true},
				}),
			);
		} catch (error) {
			expect(error).toBeInstanceOf(ComicEditorError);
			expect((error as ComicEditorError).code).toBe(
				COMIC_ERROR_CODES.LAYER_PACKAGE_FALLBACK_REQUIRED,
			);
		}

		expect(() => {
			importLayers(project, pack({sourceUrl: 'http://cdn.test/source.png'}), {
				allowedHosts: hosts,
			});
		}).toThrow(/HTTPS is required/);
		expect(project).toEqual(snapshot);
	});

	it('imports merged state layers once, converts canvas bounds, and ignores a repeat', () => {
		const project = projectWithShot();
		const imported = importLayers(project, pack(), {allowedHosts: hosts});
		const importedEye = imported.items['item:shot-1:eye'];
		if (!importedEye || importedEye.type !== 'image') {
			throw new Error('Expected imported eye image');
		}

		const animated = {
			...imported,
			items: {
				...imported.items,
				[importedEye.id]: {
					...importedEye,
					motion: {
						...importedEye.motion,
						spriteStates: [
							{frame: 0, assetId: 'asset:shot-1:eye:open'},
							{frame: 10, assetId: 'asset:shot-1:eye:closed'},
						],
					},
				},
			},
		};
		const repeated = importLayers(animated, pack(), {allowedHosts: hosts});
		const images = Object.values(repeated.items).filter((item) => {
			return item.type === 'image';
		});
		const eye = images.find((item) => item.layerId === 'eye');
		const mouth = images.find((item) => item.layerId === 'mouth');
		const background = images.find((item) => item.layerId === 'background');

		expect(images).toHaveLength(5);
		expect(images.some((item) => item.layerId === 'eye-open')).toBe(false);
		expect(eye?.assetId).toBe('asset:shot-1:eye:open');
		expect(eye?.spriteAssetIds).toEqual([
			'asset:shot-1:eye:open',
			'asset:shot-1:eye:closed',
		]);
		expect(eye?.motion?.spriteStates).toEqual([
			{frame: 0, assetId: 'asset:shot-1:eye:open'},
			{frame: 10, assetId: 'asset:shot-1:eye:closed'},
		]);
		expect(mouth?.assetId).toBe('asset:shot-1:mouth:closed');
		expect(mouth?.spriteAssetIds).toEqual([
			'asset:shot-1:mouth:closed',
			'asset:shot-1:mouth:half',
			'asset:shot-1:mouth:open',
		]);
		expect(mouth?.motion?.spriteStates).toBeUndefined();
		expect(background).toMatchObject({
			left: 50,
			top: 100,
			width: 150,
			height: 200,
		});
		expect(repeated.tracks.map((track) => track.id)).toEqual([
			'track:shot-1:foreground',
			'track:shot-1:eye',
			'track:shot-1:mouth',
			'track:shot-1:body',
			'track:shot-1:background',
		]);
		expect(
			repeated.tracks.find((track) => track.id.endsWith(':foreground'))?.hidden,
		).toBe(true);
		expect(repeated.shots?.[0]?.diagnostics).toContain('alpha-hole');
		expect(repeated.tracks).toHaveLength(imported.tracks.length);
		expect(Object.keys(repeated.items)).toHaveLength(
			Object.keys(imported.items).length,
		);
		expect(project.tracks).toHaveLength(0);
	});

	it('hides the L0 plate after import and restores it without deleting the asset', () => {
		const sequenced = appendImageSequence(projectWithShot(), {
			images: [
				{
					shotId: 'shot-1',
					url: 'https://cdn.test/source.png',
					width: 1000,
					height: 2000,
					durationInFrames: 90,
				},
			],
			allowedHosts: hosts,
		});
		const before = structuredClone(sequenced);
		const imported = importLayers(sequenced, pack(), {allowedHosts: hosts});
		const panelAssetId = 'asset:shot-1:panel';
		const panelItemId = 'item:shot-1:panel';
		const panelTrackId = 'track:shot-1:panel';

		expect(imported.assets[panelAssetId]).toEqual(
			sequenced.assets[panelAssetId],
		);
		expect(imported.items[panelItemId]).toBeDefined();
		expect(
			imported.tracks.find((track) => track.id === panelTrackId)?.hidden,
		).toBe(true);
		expect(
			imported.tracks.find((track) => track.id === 'track:shot-1:background'),
		).toBeDefined();
		expect(sequenced).toEqual(before);

		const withDialogue = {
			...imported,
			tracks: [
				...imported.tracks,
				{
					id: 'track:shot-1:dialogue:line-1',
					items: [],
					hidden: false,
					muted: false,
					shotId: 'shot-1',
					semantic: 'dialogue' as const,
					name: 'line-1',
				},
			],
		};
		const restored = restoreL0(withDialogue, 'shot-1');
		expect(restored.assets[panelAssetId]).toBeDefined();
		expect(restored.assets['asset:shot-1:background']).toBeDefined();
		expect(restored.items[panelItemId]).toBeDefined();
		expect(
			restored.tracks.find((track) => track.id === panelTrackId)?.hidden,
		).toBe(false);
		expect(
			restored.tracks.find((track) => track.id === 'track:shot-1:background')
				?.hidden,
		).toBe(true);
		expect(
			restored.tracks.find(
				(track) => track.id === 'track:shot-1:dialogue:line-1',
			)?.hidden,
		).toBe(false);
		expect(
			withDialogue.tracks.find((track) => track.id === panelTrackId)?.hidden,
		).toBe(true);
	});

	it('keeps the L0 plate visible when a package only contains cutouts', () => {
		const sequenced = appendImageSequence(projectWithShot(), {
			images: [
				{
					shotId: 'shot-1',
					url: 'https://cdn.test/source.png',
					width: 1000,
					height: 2000,
					durationInFrames: 90,
				},
			],
			allowedHosts: hosts,
		});
		const imported = importLayers(
			sequenced,
			pack({
				layers: [layer('hair', 10, {x: 120, y: 200, width: 300, height: 400})],
			}),
			{allowedHosts: hosts},
		);

		expect(
			imported.tracks.find((track) => track.id === 'track:shot-1:panel')
				?.hidden,
		).toBe(false);
		expect(
			imported.tracks.find((track) => track.id === 'track:shot-1:hair')?.hidden,
		).toBe(false);
	});

	it('keeps a clean plate separate from a background cutout', () => {
		const sequenced = appendImageSequence(projectWithShot(), {
			images: [
				{
					shotId: 'shot-1',
					url: 'https://cdn.test/source.png',
					width: 1000,
					height: 2000,
					durationInFrames: 90,
				},
			],
			allowedHosts: hosts,
		});
		const imported = importLayers(
			sequenced,
			pack({
				layers: [
					{
						...layer('background', 0),
						layerId: 'clean-plate',
						isCleanPlate: true,
						bounds: {x: 0, y: 0, width: 1000, height: 2000},
					},
					layer('background', 10, {
						x: 100,
						y: 200,
						width: 300,
						height: 400,
					}),
				],
			}),
			{allowedHosts: hosts},
		);

		expect(imported.items['item:shot-1:clean-plate']).toBeDefined();
		expect(imported.items['item:shot-1:background']).toBeDefined();
		expect(
			imported.tracks.find((entry) => entry.id === 'track:shot-1:clean-plate')
				?.role,
		).toBe('clean-plate');
		expect(
			imported.tracks.find((entry) => entry.id === 'track:shot-1:background')
				?.role,
		).toBe('cutout');
		expect(
			imported.tracks.find((entry) => entry.id === 'track:shot-1:panel')
				?.hidden,
		).toBe(true);
	});

	it('hides the blurred crop plate and restores that plate without dropping it', () => {
		const sequenced = appendImageSequence(projectWithShot(), {
			images: [
				{
					shotId: 'shot-1',
					url: 'https://cdn.test/source.png',
					width: 1000,
					height: 2000,
					durationInFrames: 90,
				},
			],
			allowedHosts: hosts,
			panelFitPolicy: BLURRED_BACKGROUND_CONTAIN,
		});
		const imported = importLayers(sequenced, pack(), {allowedHosts: hosts});
		const foregroundId = 'track:shot-1:panel-foreground';
		const backgroundId = 'track:shot-1:panel-background';

		expect(
			imported.tracks.find((track) => track.id === foregroundId)?.hidden,
		).toBe(true);
		expect(
			imported.tracks.find((track) => track.id === backgroundId)?.hidden,
		).toBe(true);
		expect(
			imported.tracks.find((track) => track.id === 'track:shot-1:body')?.hidden,
		).toBe(false);
		expect(imported.assets['asset:shot-1:panel']).toEqual(
			sequenced.assets['asset:shot-1:panel'],
		);

		const restored = restoreL0(imported, 'shot-1');
		expect(
			restored.tracks.find((track) => track.id === foregroundId)?.hidden,
		).toBe(false);
		expect(
			restored.tracks.find((track) => track.id === backgroundId)?.hidden,
		).toBe(false);
		expect(
			restored.tracks.find((track) => track.id === 'track:shot-1:body')?.hidden,
		).toBe(true);
		expect(restored.assets['asset:shot-1:panel']).toBeDefined();
		expect(restored.items['item:shot-1:panel-foreground']).toBeDefined();
	});
});
