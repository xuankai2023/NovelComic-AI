import {describe, expect, it} from 'vitest';
import {createEmptyAdvancedProjectState} from './types';
import {
	createPrecompose,
	flattenPrecompose,
	resolvePrecomposeFrame,
} from './precompose';
import {evaluateAdvancedFrame} from './evaluate-frame';

const transform = (overrides: Record<string, number> = {}) => ({
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
	...overrides,
});

const createPrecomposeInput = (
	state: ReturnType<typeof createEmptyAdvancedProjectState>,
	overrides: {
		composition?: Partial<{
			from: number;
			timeOffset: number;
			durationInFrames: number;
		}>;
		wrapper?: Partial<{
			from: number;
			durationInFrames: number;
			parentId: string | null;
			visible: boolean;
			locked: boolean;
		}>;
	} = {},
) => ({
	compositionId: state.rootCompositionId,
	layerIds: ['child'],
	composition: {
		id: 'composition:child',
		name: 'Child',
		width: 100,
		height: 100,
		fps: 30,
		durationInFrames: overrides.composition?.durationInFrames ?? 40,
		from: overrides.composition?.from ?? 0,
		timeOffset: overrides.composition?.timeOffset ?? 0,
	},
	wrapper: {
		id: 'layer:wrapper',
		name: 'Wrapper',
		zIndex: 0,
		visible: overrides.wrapper?.visible ?? true,
		locked: overrides.wrapper?.locked ?? false,
		...(overrides.wrapper?.parentId === undefined
			? {}
			: {parentId: overrides.wrapper.parentId}),
		from: overrides.wrapper?.from ?? 10,
		durationInFrames: overrides.wrapper?.durationInFrames ?? 20,
		transform: transform(),
	},
});

const createLayerState = () => {
	const state = createEmptyAdvancedProjectState(100, 100, 30, 100);
	state.layers.child = {
		id: 'child',
		itemId: 'item:child',
		compositionId: state.rootCompositionId,
		name: 'Child Layer',
		zIndex: 0,
		visible: true,
		locked: false,
		from: 5,
		durationInFrames: 30,
		transform: transform({x: 20, y: 15}),
	};
	state.compositions[state.rootCompositionId]!.layerIds = ['child'];
	return state;
};

describe('precompose', () => {
	it('maps parent frames into a child composition', () => {
		expect(
			resolvePrecomposeFrame({
				parentFrame: 20,
				from: 10,
				timeOffset: 2,
				durationInFrames: 30,
			}),
		).toBe(12);
		expect(
			resolvePrecomposeFrame({
				parentFrame: 41,
				from: 10,
				durationInFrames: 30,
			}),
		).toBeNull();
	});

	it('moves selected layers into a child composition', () => {
		const state = createEmptyAdvancedProjectState(100, 100, 30, 100);
		state.layers.a = {
			id: 'a',
			compositionId: state.rootCompositionId,
			name: 'A',
			zIndex: 0,
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
		};
		state.compositions[state.rootCompositionId]!.layerIds = ['a'];

		const next = createPrecompose(state, {
			compositionId: state.rootCompositionId,
			layerIds: ['a'],
			composition: {
				id: 'comp:character',
				name: 'Character',
				width: 1080,
				height: 1920,
				fps: 30,
				durationInFrames: 30,
			},
			wrapper: {
				id: 'layer:character',
				name: 'Character Precomp',
				zIndex: 0,
				visible: true,
				locked: false,
				transform: state.layers.a.transform,
			},
		});

		expect(next.layers.a?.compositionId).toBe('comp:character');
		expect(next.layers['layer:character']?.sourceCompositionId).toBe(
			'comp:character',
		);
		expect(next.compositions[state.rootCompositionId]?.layerIds).toEqual([
			'layer:character',
		]);
	});

	it('rejects empty, duplicate, externally parented, and cross-FPS selections', () => {
		const state = createLayerState();
		const input = createPrecomposeInput(state);

		expect(() =>
			createPrecompose(state, {...input, layerIds: []}),
		).toThrow(/non-empty unique/);
		expect(() =>
			createPrecompose(state, {...input, layerIds: ['child', 'child']}),
		).toThrow(/non-empty unique/);
		expect(() =>
			createPrecompose(state, {
				...input,
				composition: {...input.composition, fps: 24},
			}),
		).toThrow(/same FPS/);

		state.layers.parent = {
			...state.layers.child!,
			id: 'parent',
			itemId: undefined,
		};
		state.layers.child = {...state.layers.child!, parentId: 'parent'};
		expect(() => createPrecompose(state, input)).toThrow(/outside the precompose selection/);
	});

	it('rejects layers missing from the composition layer order', () => {
		const state = createLayerState();
		state.compositions[state.rootCompositionId]!.layerIds = [];

		expect(() =>
			createPrecompose(state, createPrecomposeInput(state)),
		).toThrow(/not in composition .* layer order/);
	});

	it('maps nested timing and flattens to the same active range and hierarchy', () => {
		const state = createLayerState();
		state.layers.group = {
			...state.layers.child!,
			id: 'group',
			itemId: undefined,
			zIndex: 0,
			transform: transform({x: 10, y: 5}),
		};
		state.layers.child = {...state.layers.child!, zIndex: 1};
		state.compositions[state.rootCompositionId]!.layerIds = ['group', 'child'];

		const nested = createPrecompose(state, {
			...createPrecomposeInput(state, {
				composition: {timeOffset: 2},
				wrapper: {parentId: 'group'},
			}),
		});
		const nestedFrame = evaluateAdvancedFrame(nested, undefined, 13);
		const nestedLayer = nestedFrame.layers.find((layer) => layer.id === 'child');

		expect(nestedLayer).toMatchObject({
			from: 13,
			durationInFrames: 17,
			transform: {x: 30, y: 20},
		});
		expect(
			evaluateAdvancedFrame(nested, undefined, 30).layers.find(
				(layer) => layer.id === 'child',
			),
		).toBeUndefined();

		const flattened = flattenPrecompose(nested, 'layer:wrapper');
		const flattenedLayer = evaluateAdvancedFrame(
			flattened,
			undefined,
			13,
		).layers.find((layer) => layer.id === 'child');
		expect(flattened.layers.child?.parentId).toBe('group');
		expect(flattenedLayer).toMatchObject({
			from: 13,
			durationInFrames: 17,
			transform: {x: 30, y: 20},
		});
		expect(
			evaluateAdvancedFrame(flattened, undefined, 30).layers.find(
				(layer) => layer.id === 'child',
			),
		).toBeUndefined();
		expect(flattened.compositions['composition:child']).toBeUndefined();
	});

	it('transfers wrapper visibility and lock state when flattening', () => {
		const state = createLayerState();
		const nested = createPrecompose(
			state,
			createPrecomposeInput(state, {
				wrapper: {visible: false, locked: true},
			}),
		);
		const flattened = flattenPrecompose(nested, 'layer:wrapper');

		expect(flattened.layers.child).toMatchObject({
			visible: false,
			locked: true,
		});
	});
});
