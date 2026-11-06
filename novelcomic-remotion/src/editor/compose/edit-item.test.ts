import {describe, expect, it} from 'vitest';
import {SHOT_TIMING_LOCK_MESSAGE} from '../comic/shot-owned-item';
import type {ImageItem} from '../items/image/image-item-type';
import {createComicProject} from './build-state';
import {editItem} from './edit-item';

const image = (shotId?: string): ImageItem => {
	return {
		id: 'hero',
		type: 'image',
		assetId: 'hero-asset',
		durationInFrames: 30,
		from: 0,
		top: 1,
		left: 2,
		width: 20,
		height: 40,
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
		shotId,
		layerId: shotId ? 'hero' : undefined,
	};
};

describe('editItem', () => {
		it('writes geometry, crop, opacity, rotation, and motion without mutating the input', () => {
		const item = image();
		const project = {
			...createComicProject(),
			items: {[item.id]: item},
		};
		const snapshot = structuredClone(project);
		const edited = editItem({
			project,
			itemId: item.id,
			patch: {
				left: 12,
				top: 8,
				width: 30,
				height: 50,
				opacity: 0.5,
				rotation: 15,
				cropLeft: 0.1,
				motion: {
					transform: {
						animatedProperties: ['anchorPoint', 'position'],
						x: 4,
						y: 5,
						keyframes: [
							{frame: 0, anchorX: 0.25, anchorY: 0.75, x: 3, hold: true},
						],
					},
				},
			},
		});

		expect(project).toEqual(snapshot);
		expect(edited.item).toMatchObject({
			left: 12,
			top: 8,
			width: 30,
			height: 50,
			opacity: 0.5,
			rotation: 15,
			cropLeft: 0.1,
		});
		expect(
			edited.item.type === 'image'
				? edited.item.motion?.transform?.keyframes
				: [],
		).toEqual([
			{frame: 0, anchorX: 0.25, anchorY: 0.75, x: 3, hold: true},
		]);
		expect(
			edited.item.type === 'image' ? edited.item.motion?.transform : undefined,
		).toMatchObject({
			animatedProperties: ['anchorPoint', 'position'],
			x: 4,
			y: 5,
		});
	});

	it('rejects independent duration edits for shot-owned items', () => {
		const item = image('shot-1');
		const project = {
			...createComicProject(),
			items: {[item.id]: item},
			shots: [
				{
					id: 'shot-1',
					name: 'Shot',
					from: 0,
					durationInFrames: 30,
					layerTrackIds: [],
					dialogueItemIds: [],
				},
			],
		};

		expect(() => {
			editItem({
				project,
				itemId: item.id,
				patch: {durationMs: 500},
			});
		}).toThrow(SHOT_TIMING_LOCK_MESSAGE);
		expect(() => {
			editItem({
				project,
				itemId: item.id,
				patch: {left: 9},
			});
		}).not.toThrow();
	});

	it('writes and clears image compositing fields', () => {
		const item = image();
		const project = {
			...createComicProject(),
			items: {[item.id]: item},
		};

		const edited = editItem({
			project,
			itemId: item.id,
			patch: {
				blendMode: 'multiply',
				maskAssetId: 'mask-asset',
				maskMode: 'luma',
			},
		});

		expect(edited.item).toMatchObject({
			blendMode: 'multiply',
			maskAssetId: 'mask-asset',
			maskMode: 'luma',
		});

		const cleared = editItem({
			project: edited.project,
			itemId: item.id,
			patch: {
				blendMode: 'normal',
				maskAssetId: null,
			},
		});

		expect(cleared.item).not.toHaveProperty('blendMode');
		expect(cleared.item).not.toHaveProperty('maskAssetId');
		expect(cleared.item).not.toHaveProperty('maskMode');
	});
});
