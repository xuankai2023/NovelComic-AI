import {describe, expect, it} from 'vitest';
import {
	createAdvancedLayerFromItem,
	setAdvancedLayerLock,
	setAdvancedLayerParent,
	setAdvancedLayerVisibility,
	updateAdvancedLayerTransform,
} from './advanced-actions';
import {resolveWorldTransform} from '../hierarchy/resolve-parent-transform';
import {createEmptyAdvancedProjectState} from './types';

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

const createState = () => {
	const state = createEmptyAdvancedProjectState(1080, 1920, 30, 100);
	state.layers.parent = {
		id: 'parent',
		compositionId: state.rootCompositionId,
		name: 'Parent',
		zIndex: 0,
		visible: true,
		locked: false,
		transform: transform({
			x: 100,
			y: 50,
			scaleX: 2,
			scaleY: 1.5,
			rotation: 35,
			opacity: 0.6,
		}),
	};
	state.layers.child = {
		id: 'child',
		itemId: 'item:child',
		compositionId: state.rootCompositionId,
		name: 'Child',
		zIndex: 1,
		visible: true,
		locked: false,
		transform: transform({
			x: 20,
			y: -12,
			scaleX: 0.7,
			scaleY: 1.2,
			rotation: -10,
			opacity: 0.8,
		}),
	};
	state.compositions[state.rootCompositionId]!.layerIds = ['parent', 'child'];
	return state;
};

describe('advanced layer actions', () => {
	it('creates a timeline-backed layer without mutating the previous state', () => {
		const state = createEmptyAdvancedProjectState(1080, 1920, 30, 100);
		const next = createAdvancedLayerFromItem(state, {
			layerId: 'advanced:item:1',
			itemId: 'item:1',
			name: 'Character',
			transform: transform({x: 20, y: 30}),
			from: 12,
			durationInFrames: 40,
		});

		expect(state.compositions[state.rootCompositionId]?.layerIds).toEqual([]);
		expect(next.compositions[state.rootCompositionId]?.layerIds).toEqual([
			'advanced:item:1',
		]);
		expect(next.layers['advanced:item:1']).toMatchObject({
			itemId: 'item:1',
			from: 12,
			durationInFrames: 40,
			transform: {x: 20, y: 30},
		});
	});

	it('preserves the current world transform when changing parent', () => {
		const state = createState();
		const before = resolveWorldTransform('child', state.layers, 12);
		const next = setAdvancedLayerParent(state, {
			layerId: 'child',
			parentId: 'parent',
			keepWorldTransform: true,
			frame: 12,
		});
		const after = resolveWorldTransform('child', next.layers, 12);

		expect(next.layers.child?.parentId).toBe('parent');
		expect(after.x).toBeCloseTo(before.x);
		expect(after.y).toBeCloseTo(before.y);
		expect(after.scaleX).toBeCloseTo(before.scaleX);
		expect(after.scaleY).toBeCloseTo(before.scaleY);
		expect(after.rotation).toBeCloseTo(before.rotation);
		expect(after.opacity).toBeCloseTo(before.opacity);
	});

	it('rejects self-parenting, cross-composition parents, and cycles', () => {
		const state = createState();
		const childOfParent = setAdvancedLayerParent(state, {
			layerId: 'child',
			parentId: 'parent',
		});
		const otherComposition = {
			...state,
			compositions: {
				...state.compositions,
				'composition:other': {
					id: 'composition:other',
					name: 'Other',
					width: 1080,
					height: 1920,
					fps: 30,
					durationInFrames: 100,
					layerIds: [],
				},
			},
			layers: {
				...state.layers,
				other: {
					...state.layers.parent!,
					id: 'other',
					compositionId: 'composition:other',
				},
			},
		};

		expect(() =>
			setAdvancedLayerParent(state, {
				layerId: 'parent',
				parentId: 'parent',
			}),
		).toThrow(/own parent/);
		expect(() =>
			setAdvancedLayerParent(childOfParent, {
				layerId: 'parent',
				parentId: 'child',
			}),
		).toThrow(/cycle/);
		expect(() =>
			setAdvancedLayerParent(otherComposition, {
				layerId: 'child',
				parentId: 'other',
			}),
		).toThrow(/same composition/);
	});

	it('rejects preserving world transform under a zero-scale parent', () => {
		const state = createState();
		state.layers.parent = {
			...state.layers.parent!,
			transform: transform({scaleX: 0}),
		};

		expect(() =>
			setAdvancedLayerParent(state, {
				layerId: 'child',
				parentId: 'parent',
				keepWorldTransform: true,
			}),
		).toThrow(/zero scale/);
	});

	it('updates transform, visibility, and lock state immutably', () => {
		const state = createState();
		const transformed = updateAdvancedLayerTransform(state, {
			layerId: 'child',
			patch: {x: 25, rotation: 15},
		});
		const hidden = setAdvancedLayerVisibility(transformed, 'child', false);
		const locked = setAdvancedLayerLock(hidden, 'child', true);

		expect(state.layers.child?.transform.x).toBe(20);
		expect(locked.layers.child).toMatchObject({
			visible: false,
			locked: true,
			transform: {x: 25, rotation: 15},
		});
	});
});
