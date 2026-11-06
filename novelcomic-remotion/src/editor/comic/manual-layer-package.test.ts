import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import {createComicProject} from '../compose/build-state';
import type {ImageItem} from '../items/image/image-item-type';
import {addDialogue} from './add-dialogue';
import {appendImageSequence} from './append-image-sequence';
import {
	buildManualLayerPackage,
	importManualLayers,
} from './manual-layer-package';
import type {ComicEditLayer} from './manual-layer-types';
import {upsertShot} from './upsert-shot';

const imageAsset = (
	id: string,
	width: number,
	height: number,
	remoteUrl = `https://cdn.test/${id}.png`,
): ImageAsset => ({
	id,
	type: 'image',
	filename: `${id}.png`,
	size: 1,
	remoteUrl,
	remoteFileKey: null,
	mimeType: 'image/png',
	width,
	height,
});

const manualLayer = (
	id: string,
	semantic: ComicEditLayer['semantic'],
	cutoutAssetId: string,
	overrides?: Partial<ComicEditLayer>,
): ComicEditLayer => ({
	id,
	name: id,
	semantic,
	sourceAssetId: 'asset:shot-1:panel',
	sourceItemId: 'item:shot-1:panel',
	shotId: 'shot-1',
	sourceCanvas: {width: 1000, height: 2000},
	bounds: {x: 100, y: 200, width: 200, height: 160},
	polygon: [
		{x: 100, y: 200},
		{x: 300, y: 200},
		{x: 300, y: 360},
	],
	cutoutAssetId,
	visible: true,
	locked: false,
	opacity: 1,
	zIndex: 10,
	...overrides,
});

const projectWithManualLayers = () => {
	let project = upsertShot(
		createComicProject({compositionWidth: 500, compositionHeight: 1000}),
		{shotId: 'shot-1', durationInFrames: 90},
	);
	project = appendImageSequence(project, {
		allowedHosts: ['cdn.test'],
		images: [
			{
				shotId: 'shot-1',
				url: 'https://cdn.test/source.png',
				width: 1000,
				height: 2000,
				durationInFrames: 90,
			},
		],
	});
	project.assets.hair = imageAsset('hair', 200, 160);
	project.assets['eye-open'] = imageAsset('eye-open', 200, 160);
	project.assets['eye-closed'] = imageAsset('eye-closed', 200, 160);
	project.assets['mouth-closed'] = imageAsset('mouth-closed', 200, 160);
	project.assets['mouth-half'] = imageAsset('mouth-half', 200, 160);
	project.assets['mouth-open'] = imageAsset('mouth-open', 200, 160);
	project.comicEditLayers = {
		hair: manualLayer('hair', 'hair', 'hair', {zIndex: 20}),
		'eye-open': manualLayer('eye-open', 'eye-open', 'eye-open', {
			zIndex: 30,
		}),
		'eye-closed': manualLayer('eye-closed', 'eye-closed', 'eye-closed', {
			zIndex: 30,
		}),
		'mouth-closed': manualLayer(
			'mouth-closed',
			'mouth-closed',
			'mouth-closed',
			{zIndex: 25},
		),
		'mouth-half': manualLayer('mouth-half', 'mouth-half', 'mouth-half', {
			zIndex: 25,
		}),
		'mouth-open': manualLayer('mouth-open', 'mouth-open', 'mouth-open', {
			zIndex: 25,
		}),
	};
	return project;
};

describe('manual layer package', () => {
	it('converts manual layers into stable package layers with shared bounds', () => {
		const project = projectWithManualLayers();
		project.comicEditLayers!.hair!.opacity = 0.4;
		const layerPackage = buildManualLayerPackage(project, 'shot-1');

		expect(layerPackage.sourceUrl).toBe('https://cdn.test/source.png');
		expect(layerPackage.layers.map((layer) => layer.layerId)).toEqual([
			'hair',
			'mouth-closed',
			'mouth-half',
			'mouth-open',
			'eye-closed',
			'eye-open',
		]);
		expect(
			layerPackage.layers.find((layer) => layer.layerId === 'hair'),
		).toMatchObject({
			bounds: {x: 100, y: 200, width: 200, height: 160},
			anchor: {x: 0.5, y: 0},
			motionPolicy: 'subtle',
			opacity: 0.4,
		});
	});

	it('adds a clean plate layer and keeps L0 visible without one', () => {
		const project = projectWithManualLayers();
		const packageWithoutPlate = buildManualLayerPackage(project, 'shot-1');
		expect(
			packageWithoutPlate.layers.some(
				(layer) => layer.layerId === 'clean-plate',
			),
		).toBe(false);

		project.assets.clean = imageAsset('clean', 1000, 2000);
		project.comicEditLayers!.hair!.cleanPlateAssetId = 'clean';
		const packageWithPlate = buildManualLayerPackage(project, 'shot-1');
		expect(packageWithPlate.layers[0]).toMatchObject({
			layerId: 'clean-plate',
			semantic: 'background',
			bounds: {x: 0, y: 0, width: 1000, height: 2000},
		});

		const importedWithoutPlate = importManualLayers(
			projectWithManualLayers(),
			'shot-1',
			{allowedHosts: ['cdn.test'], applyDefaultMotion: false},
		);
		expect(
			importedWithoutPlate.tracks.find(
				(track) => track.id === 'track:shot-1:panel',
			)?.hidden,
		).toBe(false);

		const projectWithPlate = projectWithManualLayers();
		projectWithPlate.assets.clean = imageAsset('clean', 1000, 2000);
		projectWithPlate.comicEditLayers!.hair!.cleanPlateAssetId = 'clean';
		const importedWithPlate = importManualLayers(projectWithPlate, 'shot-1', {
			allowedHosts: ['cdn.test'],
			applyDefaultMotion: false,
		});
		expect(
			importedWithPlate.tracks.find(
				(track) => track.id === 'track:shot-1:panel',
			)?.hidden,
		).toBe(true);
		expect(importedWithPlate.items['item:shot-1:clean-plate']).toBeDefined();
	});

	it('does not hide L0 for a manual background cutout', () => {
		const project = projectWithManualLayers();
		project.comicEditLayers!.hair!.semantic = 'background';

		const imported = importManualLayers(project, 'shot-1', {
			allowedHosts: ['cdn.test'],
			applyDefaultMotion: false,
		});

		expect(
			imported.tracks.find((track) => track.id === 'track:shot-1:panel')
				?.hidden,
		).toBe(false);
	});

	it('replaces legacy manual tracks and wires hair, blink, and mouth motion', () => {
		const project = addDialogue(projectWithManualLayers(), {
			lines: [
				{
					lineId: 'line-1',
					shotId: 'shot-1',
					text: 'hello',
					from: 10,
					durationInFrames: 30,
				},
			],
		});
		const source = project.items['item:shot-1:panel'] as ImageItem;
		project.items['legacy-hair'] = {
			...source,
			id: 'legacy-hair',
			assetId: 'hair',
			layerId: 'hair',
		};
		project.tracks.push({
			id: 'legacy-hair-track',
			items: ['legacy-hair'],
			hidden: false,
			muted: false,
			shotId: 'shot-1',
			semantic: 'hair',
		});
		project.shots![0]!.layerTrackIds.push('legacy-hair-track');

		const imported = importManualLayers(project, 'shot-1', {
			allowedHosts: ['cdn.test'],
			animationSeed: 7,
		});

		expect(imported.items['legacy-hair']).toBeUndefined();
		expect(imported.items['item:shot-1:hair']).toMatchObject({
			from: 0,
			durationInFrames: 90,
		});
		expect(imported.items['item:shot-1:hair']).toHaveProperty(
			'motion.transform',
		);
		expect(imported.items['item:shot-1:eye']).toHaveProperty(
			'motion.spriteStates',
		);
		expect(imported.items['item:shot-1:mouth']).toHaveProperty(
			'motion.spriteStates',
		);
		expect(imported.items['item:shot-1:eye']).toMatchObject({
			left: 50,
			top: 100,
			width: 100,
			height: 80,
		});
	});

	it('preserves manual opacity on the imported image item', () => {
		const project = projectWithManualLayers();
		project.comicEditLayers!.hair!.opacity = 0.4;

		const imported = importManualLayers(project, 'shot-1', {
			allowedHosts: ['cdn.test'],
			applyDefaultMotion: false,
		});

		expect(imported.items['item:shot-1:hair']).toMatchObject({
			opacity: 0.4,
		});
	});

	it('rejects sprite variants that are not aligned', () => {
		const project = projectWithManualLayers();
		project.comicEditLayers!['eye-closed']!.bounds = {
			x: 120,
			y: 200,
			width: 200,
			height: 160,
		};

		expect(() => buildManualLayerPackage(project, 'shot-1')).toThrow(
			/share bounds and anchor/,
		);
	});
});
