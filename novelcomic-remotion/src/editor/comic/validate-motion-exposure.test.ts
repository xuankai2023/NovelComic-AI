import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import {createComicProject} from '../compose/build-state';
import type {ImageItem} from '../items/image/image-item-type';
import {upsertShot} from './upsert-shot';
import {
	validateMotionExposure,
	validateMotionExposureForProject,
} from './validate-motion-exposure';

const imageAsset = (id: string, width: number, height: number): ImageAsset => ({
	id,
	type: 'image',
	filename: `${id}.png`,
	size: 1,
	remoteUrl: `https://cdn.test/${id}.png`,
	remoteFileKey: null,
	mimeType: 'image/png',
	width,
	height,
});

const imageItem = (id: string, overrides?: Partial<ImageItem>): ImageItem => ({
	id,
	type: 'image',
	assetId: 'clean-asset',
	durationInFrames: 30,
	from: 0,
	top: 0,
	left: 0,
	width: 100,
	height: 100,
	opacity: 1,
	isDraggingInTimeline: false,
	borderRadius: 0,
	rotation: 0,
	keepAspectRatio: true,
	fadeInDurationInSeconds: 0,
	fadeOutDurationInSeconds: 0,
	cropLeft: 0,
	cropTop: 0,
	cropRight: 0,
	cropBottom: 0,
	shotId: 'shot-1',
	layerId: 'clean-plate',
	...overrides,
});

const projectWithCleanPlate = (): ReturnType<typeof createComicProject> => {
	const project = upsertShot(
		createComicProject({
			compositionWidth: 100,
			compositionHeight: 100,
		}),
		{shotId: 'shot-1', durationInFrames: 30},
	);
	project.assets['clean-asset'] = imageAsset('clean-asset', 100, 100);
	project.items['item:shot-1:clean-plate'] = imageItem(
		'item:shot-1:clean-plate',
	);
	project.tracks.push({
		id: 'track:shot-1:clean-plate',
		items: ['item:shot-1:clean-plate'],
		hidden: false,
		muted: false,
		shotId: 'shot-1',
		semantic: 'background',
	});
	project.shots![0]!.layerTrackIds = ['track:shot-1:clean-plate'];
	return project;
};

describe('validateMotionExposure', () => {
	it('accepts a full clean plate during hair rotation', () => {
		const project = projectWithCleanPlate();
		project.assets['hair-asset'] = imageAsset('hair-asset', 20, 20);
		project.items['item:shot-1:hair'] = imageItem('item:shot-1:hair', {
			assetId: 'hair-asset',
			layerId: 'hair',
			left: 40,
			top: 20,
			width: 20,
			height: 20,
			motion: {
				transform: {
						keyframes: [
							{frame: 0, rotation: 0},
							{frame: 15, rotation: 3},
							{frame: 29, rotation: 0},
					],
					anchorX: 0.5,
					anchorY: 0.5,
				},
			},
		});
		project.tracks.push({
			id: 'track:shot-1:hair',
			items: ['item:shot-1:hair'],
			hidden: false,
			muted: false,
			shotId: 'shot-1',
			semantic: 'hair',
		});
		project.shots![0]!.layerTrackIds.push('track:shot-1:hair');

		expect(validateMotionExposureForProject(project)).toEqual([]);
	});

	it('accepts a camera push because the plate remains larger than the canvas', () => {
		const project = projectWithCleanPlate();
		project.shots![0]!.cameraMotion = {
			keyframes: [
				{frame: 0, scale: 1},
				{frame: 29, scale: 1.08},
			],
		};

		expect(validateMotionExposureForProject(project)).toEqual([]);
	});

	it('reports a clean plate that moves outside the composition', () => {
		const project = projectWithCleanPlate();
		project.items['item:shot-1:clean-plate'] = imageItem(
			'item:shot-1:clean-plate',
			{
				motion: {
					transform: {
						keyframes: [
							{frame: 0, x: 8},
							{frame: 29, x: 8},
						],
					},
				},
			},
		);

		expect(validateMotionExposure(project, project.shots![0]!)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: 'MOTION_EXPOSES_TRANSPARENT_AREA',
					shotId: 'shot-1',
					frame: 0,
				}),
			]),
		);
	});

	it('does not fail when L0 is the fallback without a clean plate', () => {
		const project = projectWithCleanPlate();
		delete project.items['item:shot-1:clean-plate'];
		project.tracks[0]!.items = [];
		project.items['item:shot-1:hair'] = imageItem('item:shot-1:hair', {
			layerId: 'hair',
			motion: {
				transform: {
					keyframes: [{frame: 0}, {frame: 29, x: 80}],
				},
			},
		});
		project.tracks[0]!.items = ['item:shot-1:hair'];

		expect(validateMotionExposureForProject(project)).toEqual([]);
	});

	it('reports source animation and non-identity initial motion', () => {
		const project = projectWithCleanPlate();
		project.tracks = project.tracks.map((track) => ({
			...track,
			role: 'source' as const,
		}));
		const cleanPlate = project.items['item:shot-1:clean-plate'];
		if (cleanPlate?.type !== 'image') {
			throw new Error('Expected image clean plate');
		}
		cleanPlate.motion = {
			transform: {
				keyframes: [{frame: 0, x: 8}],
			},
		};

		const issues = validateMotionExposureForProject(project);
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: 'SOURCE_LAYER_ANIMATED',
					itemId: 'item:shot-1:clean-plate',
				}),
			]),
		);

		project.tracks = project.tracks.map((track) => ({
			...track,
			role: 'clean-plate' as const,
		}));
		cleanPlate.layerId = 'clean-plate';
		cleanPlate.motion = {
			transform: {
				keyframes: [{frame: 0, x: 8}],
			},
		};
		expect(validateMotionExposureForProject(project)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({code: 'MOTION_INITIAL_ALIGNMENT'}),
			]),
		);
	});
});
