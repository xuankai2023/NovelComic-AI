import {describe, expect, it} from 'vitest';
import {createEmptyAdvancedProjectState} from '../composition/types';
import {
	applyTrackMatteCoverage,
	lumaFromRgba,
	trackMatteCoverage,
	validateTrackMattes,
} from './track-matte';

describe('track matte coverage', () => {
	it('supports alpha and inverted alpha coverage', () => {
		expect(
			trackMatteCoverage({layerId: 'matte', type: 'alpha'}, 0.25, 0.9),
		).toBe(0.25);
		expect(
			trackMatteCoverage(
				{layerId: 'matte', type: 'alpha-inverted'},
				0.25,
				0.9,
			),
		).toBe(0.75);
		expect(
			applyTrackMatteCoverage(
				0.8,
				{layerId: 'matte', type: 'luma'},
				1,
				0.5,
			),
		).toBeCloseTo(0.4);
	});

	it('uses perceptual luma for luma mattes', () => {
		expect(lumaFromRgba(1, 0, 0)).toBeCloseTo(0.2126);
		expect(lumaFromRgba(0, 1, 0)).toBeCloseTo(0.7152);
	});

	it('reports self references, missing references and cycles', () => {
		const state = createEmptyAdvancedProjectState();
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
				width: 10,
				height: 10,
				scaleX: 1,
				scaleY: 1,
				rotation: 0,
				opacity: 1,
				anchorX: 0.5,
				anchorY: 0.5,
			},
			matte: {layerId: 'b', type: 'alpha'},
		};
		state.layers.b = {
			...state.layers.a,
			id: 'b',
			name: 'B',
			zIndex: 1,
			matte: {layerId: 'a', type: 'alpha'},
		};
		state.layers.c = {
			...state.layers.a,
			id: 'c',
			name: 'C',
			zIndex: 2,
			matte: {layerId: 'c', type: 'alpha'},
		};
		state.layers.d = {
			...state.layers.a,
			id: 'd',
			name: 'D',
			zIndex: 3,
			matte: {layerId: 'missing', type: 'alpha'},
		};

		const issues = validateTrackMattes(state);
		expect(issues.map((issue) => issue.layerId)).toEqual(
			expect.arrayContaining(['a', 'b', 'c', 'd']),
		);
	});
});
