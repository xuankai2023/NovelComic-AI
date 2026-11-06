import {describe, expect, it} from 'vitest';
import {evaluateAdvancedFrame} from './evaluate-frame';
import {createEmptyAdvancedProjectState} from './types';

const layer = (id: string, zIndex: number) => ({
	id,
	compositionId: 'composition:root',
	name: id,
	zIndex,
	visible: true,
	locked: false,
	transform: {
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		scaleX: 1,
		scaleY: 1,
		rotation: 0,
		opacity: 1,
		anchorX: 0.5,
		anchorY: 0.5,
	},
});

describe('evaluateAdvancedFrame', () => {
	it('returns layers in render order with current parent transform', () => {
		const state = createEmptyAdvancedProjectState(1080, 1920, 30, 100);
		state.layers.background = layer('background', 0);
		const character = layer('character', 1);
		state.layers.character = {
			...character,
			itemId: 'item:character',
			parentId: 'background',
			transform: {
				...character.transform,
				x: 20,
			},
		};
		state.compositions[state.rootCompositionId]!.layerIds = [
			'character',
			'background',
		];

		const result = evaluateAdvancedFrame(state, undefined, 5);

		expect(result.layers.map((entry) => entry.id)).toEqual([
			'background',
			'character',
		]);
		expect(result.layers[1]?.itemId).toBe('item:character');
		expect(result.layers[1]?.transform.x).toBe(20);
	});

	it('resolves current subtitle and lip-sync state', () => {
		const state = createEmptyAdvancedProjectState(1080, 1920, 30, 100);
		state.layers.mouth = layer('mouth', 1);
		state.layers.mouth = {
			...state.layers.mouth,
			itemId: 'item:mouth',
		};
		state.compositions[state.rootCompositionId]!.layerIds = ['mouth'];
		state.subtitles.track = {
			id: 'track',
			style: 'default',
			items: [{id: 'line', text: 'Hello', from: 5, durationInFrames: 10}],
		};
		state.lipSyncTracks.lip = {
			id: 'lip',
			mouthLayerId: 'mouth',
			dialogueItemId: 'line',
			mode: 'rule',
			states: [{from: 5, to: 10, assetId: 'mouth-open'}],
			fallbackState: 'mouth-closed',
		};

		const result = evaluateAdvancedFrame(state, state.rootCompositionId, 7);

		expect(result.subtitles.map((item) => item.text)).toEqual(['Hello']);
		expect(result.layers[0]?.spriteAssetId).toBe('mouth-open');
	});

	it('inherits parent visibility, lock state, and active time range', () => {
		const state = createEmptyAdvancedProjectState(1080, 1920, 30, 100);
		const parent = {
			...layer('parent', 0),
			from: 10,
			durationInFrames: 20,
			visible: false,
			locked: true,
		};
		const child = {
			...layer('child', 1),
			itemId: 'item:child',
			parentId: 'parent',
		};
		state.layers.parent = parent;
		state.layers.child = child;
		state.compositions[state.rootCompositionId]!.layerIds = ['parent', 'child'];

		expect(evaluateAdvancedFrame(state, undefined, 9).layers).toEqual([]);
		expect(evaluateAdvancedFrame(state, undefined, 15).layers).toEqual([]);

		state.layers.parent = {...parent, visible: true};
		const visible = evaluateAdvancedFrame(state, undefined, 15);
		expect(visible.layers.map((evaluated) => evaluated.id)).toEqual([
			'parent',
			'child',
		]);
		expect(visible.layers[1]?.locked).toBe(true);
		expect(evaluateAdvancedFrame(state, undefined, 30).layers).toEqual([]);
	});

	it('evaluates a pre-compose at its mapped child frame and wrapper range', () => {
		const state = createEmptyAdvancedProjectState(100, 100, 30, 100);
		state.layers.child = {
			...layer('child', 0),
			itemId: 'item:child',
			from: 5,
			durationInFrames: 30,
		};
		state.compositions[state.rootCompositionId]!.layerIds = ['child'];
		state.compositions['composition:child'] = {
			id: 'composition:child',
			name: 'Child',
			width: 100,
			height: 100,
			fps: 30,
			durationInFrames: 40,
			timeOffset: 2,
			layerIds: ['child'],
		};
		state.layers['layer:wrapper'] = {
			...layer('layer:wrapper', 0),
			compositionId: state.rootCompositionId,
			sourceCompositionId: 'composition:child',
			from: 10,
			durationInFrames: 20,
		};
		state.layers.child = {...state.layers.child!, compositionId: 'composition:child'};
		state.compositions[state.rootCompositionId]!.layerIds = ['layer:wrapper'];

		const inside = evaluateAdvancedFrame(state, undefined, 13);
		expect(inside.layers).toHaveLength(1);
		expect(inside.layers[0]).toMatchObject({
			id: 'child',
			itemId: 'item:child',
			from: 13,
			durationInFrames: 17,
		});
		expect(evaluateAdvancedFrame(state, undefined, 30).layers).toEqual([]);
	});
});
