import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const REMOVED_REMOTION_IMPLEMENTATIONS = [
	'src/editor/items/text/create-text-item.ts',
	'src/editor/items/text/text-layer.tsx',
	'src/editor/items/text/text-editor.tsx',
	'src/editor/items/solid/solid-layer.tsx',
	'src/editor/canvas/text-insertion-tool.tsx',
	'src/editor/canvas/solid-drawing-tool.tsx',
	'src/editor/canvas/manual-layer-tool.tsx',
	'src/editor/canvas/pen-tool.tsx',
	'src/editor/masks/mask-coverage.ts',
	'src/editor/selection-border/selection-outline.tsx',
	'src/editor/state/actions/adjustment-layers.ts',
	'src/editor/state/actions/pen-paths.ts',
];

describe('Compositor and Remotion ownership boundary', () => {
	it('keeps overlapping image-editing implementations out of Remotion', () => {
		for (const file of REMOVED_REMOTION_IMPLEMENTATIONS) {
			expect(existsSync(resolve(file)), `${file} belongs to Compositor`).toBe(
				false,
			);
		}
	});

	it('limits the legacy Remotion tool mode to timeline navigation', () => {
		const source = readFileSync(resolve('src/editor/edit-mode.tsx'), 'utf8');
		expect(source).not.toMatch(
			/draw-solid|create-text|trace-layer|magic-wand|color-range|pen-tool/,
		);
	});

	it('keeps Remotion as a thin adapter over the Compositor document', () => {
		const source = readFileSync(resolve('src/remotion/main.tsx'), 'utf8');
		expect(source).toContain('DocumentState');
		expect(source).toContain('<MainComposition document={document}');
	});
});
