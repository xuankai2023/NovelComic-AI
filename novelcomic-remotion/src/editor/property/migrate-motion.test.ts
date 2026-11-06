import {describe, expect, it} from 'vitest';
import {toCompositionProps} from '../rendering/to-composition-props';
import {normalizeUndoableState} from '../state/normalize-undoable-state';
import type {UndoableState} from '../state/types';
import {evaluatePropertyGraph} from './evaluate-property';
import {materializeLegacyMotion, writePropertySet} from './materialize-motion';
import {migrateMotionToPropertyGraph} from './migrate-motion';
import {propertySetId} from './types';

const project = (): UndoableState => ({
	schemaVersion: 2,
	tracks: [{id: 'track-1', items: ['item-1'], hidden: false, muted: false}],
	assets: {},
	deletedAssets: [],
	fps: 30,
	compositionWidth: 1080,
	compositionHeight: 1920,
	items: {
		'item-1': {
			id: 'item-1',
			type: 'image',
			assetId: 'asset-1',
			from: 10,
			durationInFrames: 20,
			left: 0,
			top: 0,
			width: 100,
			height: 100,
			isDraggingInTimeline: false,
			opacity: 1,
			rotation: 0,
			keepAspectRatio: true,
			borderRadius: 0,
			cropLeft: 0,
			cropTop: 0,
			cropRight: 0,
			cropBottom: 0,
			fadeInDurationInSeconds: 0,
			fadeOutDurationInSeconds: 0,
			motion: {
				transform: {
					x: 3,
					keyframes: [
						{frame: 0, x: 3, easing: 'linear'},
						{frame: 10, x: 13, easing: 'ease-in'},
					],
				},
			},
		},
	},
	shots: [
		{
			id: 'shot-1',
			name: 'Shot',
			from: 0,
			durationInFrames: 30,
			layerTrackIds: ['track-1'],
			dialogueItemIds: [],
			cameraMotion: {
				keyframes: [
					{frame: 0, scale: 1},
					{frame: 20, scale: 1.2},
				],
			},
		},
	],
	advanced: {
		schemaVersion: 1,
		rootCompositionId: 'root',
		compositions: {
			root: {
				id: 'root',
				name: 'Root',
				width: 1080,
				height: 1920,
				fps: 30,
				durationInFrames: 30,
				layerIds: ['layer-1'],
			},
		},
		layers: {
			'layer-1': {
				id: 'layer-1',
				compositionId: 'root',
				name: 'Layer',
				zIndex: 0,
				visible: true,
				locked: false,
				transform: {
					x: 10,
					y: 20,
					width: 100,
					height: 100,
					scaleX: 1,
					scaleY: 1,
					rotation: 0,
					opacity: 1,
					anchorX: 0.5,
					anchorY: 0.5,
				},
				motion: {keyframes: [{frame: 5, x: 5, opacity: 0.5}]},
				masks: [
					{
						id: 'mask-1',
						mode: 'add',
						inverted: false,
						feather: 0,
						expansion: 0,
						points: [],
					},
				],
			},
		},
		subtitles: {},
		lipSyncTracks: {},
		expressions: {},
	},
});

describe('motion PropertyGraph migration', () => {
	it.each([1, 2])(
		'migrates schema %s item, shot and Advanced data to schema 3',
		(schemaVersion) => {
			const source = {...project(), schemaVersion};
			const result = migrateMotionToPropertyGraph(source);
			expect(result.state.schemaVersion).toBe(3);
			expect(Object.keys(result.state.propertyGraph!.sets)).toEqual([
				'item:item-1',
				'shot:shot-1',
				'advanced-layer:layer-1',
			]);
			expect(result.warnings).toEqual(
				expect.arrayContaining([expect.objectContaining({field: 'masks'})]),
			);
			expect(result.state.advanced?.layers['layer-1']?.masks?.[0]?.id).toBe(
				'mask-1',
			);
		},
	);

	it('normalizes old projects and projects graph values back to legacy render input', () => {
		const normalized = normalizeUndoableState(project());
		const owner = {kind: 'item', id: 'item-1'} as const;
		const set = normalized.propertyGraph!.sets[propertySetId(owner)]!;
		expect(
			evaluatePropertyGraph({
				graph: normalized.propertyGraph!,
				owner,
				frame: 5,
				durationInFrames: 20,
			}).x,
		).toBeCloseTo(4.25);

		const changed = writePropertySet(normalized, {
			...set,
			properties: {...set.properties, x: {baseValue: 40, keyframes: []}},
		});
		expect(
			changed.items['item-1']?.type === 'image' &&
				changed.items['item-1'].motion?.transform?.x,
		).toBe(40);
		expect(materializeLegacyMotion(changed).items['item-1']).toEqual(
			changed.items['item-1'],
		);
		const staleLegacyProjection = {
			...changed,
			items: project().items,
			assets: {},
		};
		const renderItem = toCompositionProps(staleLegacyProjection).items[
			'item-1'
		];
		expect(
			renderItem?.type === 'image' && renderItem.motion?.transform?.x,
		).toBe(40);
	});

	it('preserves Advanced relative motion when materialized', () => {
		const migrated = migrateMotionToPropertyGraph(project()).state;
		const materialized = materializeLegacyMotion(migrated);
		expect(
			materialized.advanced?.layers['layer-1']?.motion?.keyframes[0],
		).toEqual(expect.objectContaining({frame: 5, x: 5, opacity: 0.5}));
	});
});
