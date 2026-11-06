import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import type {ComicEditLayer} from './manual-layer-types';
import {validateManualLayerBounds} from './validate-layer-bounds';

const layer = (overrides: Partial<ComicEditLayer> = {}): ComicEditLayer => ({
	id: 'hair',
	name: 'Hair',
	semantic: 'hair',
	sourceAssetId: 'source',
	sourceCanvas: {width: 1000, height: 2000},
	bounds: {x: 100, y: 200, width: 300, height: 400},
	visible: true,
	locked: false,
	opacity: 1,
	zIndex: 1,
	...overrides,
});

describe('validateManualLayerBounds', () => {
	it('accepts bounds that remain inside the source canvas', () => {
		const project = createComicProject();
		project.comicEditLayers = {hair: layer()};
		expect(validateManualLayerBounds(project)).toEqual([]);
	});

	it('reports out-of-range bounds, anchors, and polygon points', () => {
		const project = createComicProject();
		project.comicEditLayers = {
			hair: layer({
				bounds: {x: 900, y: 200, width: 300, height: 400},
				anchor: {x: 1.2, y: 0.5},
				polygon: [
					{x: 100, y: 100},
					{x: 1200, y: 100},
					{x: 100, y: 300},
				],
			}),
		};

		expect(
			validateManualLayerBounds(project).map((entry) => entry.code),
		).toEqual([
			'LAYER_BOUNDS_OUT_OF_RANGE',
			'LAYER_ANCHOR_OUT_OF_RANGE',
			'LAYER_POLYGON_OUT_OF_RANGE',
		]);
	});
});
