import {describe, expect, it} from 'vitest';
import type {LayerNode} from '../composition/types';
import {resolveWorldTransform} from './resolve-parent-transform';

const transform = (overrides: Partial<LayerNode['transform']> = {}) => ({
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

describe('resolveWorldTransform', () => {
	it('composes parent position, scale, rotation, and opacity', () => {
		const layers: Record<string, LayerNode> = {
			parent: {
				id: 'parent',
				compositionId: 'root',
				name: 'Parent',
				zIndex: 0,
				visible: true,
				locked: false,
				transform: transform({
					x: 10,
					y: 20,
					scaleX: 2,
					scaleY: 2,
					rotation: 90,
					opacity: 0.5,
				}),
			},
			child: {
				id: 'child',
				compositionId: 'root',
				parentId: 'parent',
				name: 'Child',
				zIndex: 1,
				visible: true,
				locked: false,
				transform: transform({x: 5, y: 0, opacity: 0.8}),
			},
		};

		expect(resolveWorldTransform('child', layers, 0)).toMatchObject({
			x: 10,
			y: 30,
			scaleX: 2,
			scaleY: 2,
			rotation: 90,
			opacity: 0.4,
		});
	});

	it('rejects parent cycles', () => {
		const layers: Record<string, LayerNode> = {
			a: {
				id: 'a',
				compositionId: 'root',
				parentId: 'b',
				name: 'A',
				zIndex: 0,
				visible: true,
				locked: false,
				transform: transform(),
			},
			b: {
				id: 'b',
				compositionId: 'root',
				parentId: 'a',
				name: 'B',
				zIndex: 1,
				visible: true,
				locked: false,
				transform: transform(),
			},
		};

		expect(() => resolveWorldTransform('a', layers, 0)).toThrow(/cycle/);
	});
});
