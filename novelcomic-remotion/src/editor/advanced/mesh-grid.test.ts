import {describe, expect, it} from 'vitest';
import {
	affineMatrixForTriangle,
	createIdentityMeshGrid,
	evaluateMeshPoints,
	meshGridToTriangles,
} from './mesh-grid';

describe('mesh grid', () => {
	it('creates an identity grid and splits it into triangles', () => {
		const grid = createIdentityMeshGrid(3, 3);
		expect(evaluateMeshPoints(grid, 0)).toEqual(grid.points);
		expect(meshGridToTriangles(grid, 100, 100)).toHaveLength(8);
	});

	it('calculates a triangle affine transform', () => {
		const matrix = affineMatrixForTriangle(
			[
				{x: 0, y: 0},
				{x: 1, y: 0},
				{x: 0, y: 1},
			],
			[
				{x: 1, y: 2},
				{x: 3, y: 2},
				{x: 1, y: 4},
			],
		);
		expect(matrix).toEqual([2, 0, 0, 2, 1, 2]);
	});
});
