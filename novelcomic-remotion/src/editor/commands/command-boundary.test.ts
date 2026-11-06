import {readFileSync, readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const UI_DIRECTORIES = [
	'src/editor/inspector',
	'src/editor/canvas',
	'src/editor/timeline',
	'src/editor/shot-panel',
	'src/editor/sidebar',
];

describe('editor command boundary', () => {
	it('keeps raw EditorState setters out of project editing UI', () => {
		for (const directory of UI_DIRECTORIES) {
			const files = readdirSync(resolve(directory), {
				recursive: true,
				encoding: 'utf8',
			});
			for (const file of files) {
				if (!/\.(ts|tsx)$/.test(file)) continue;
				const absolute = resolve(directory, file);
				const source = readFileSync(absolute, 'utf8');
				expect(
					source,
					`${absolute} bypasses TimelineWriteOnlyContext`,
				).not.toMatch(/setStateWithoutHistory|setEditorState/);
			}
		}
	});

	it('keeps the raw setter private to the root and project hydration boundary', () => {
		const context = readFileSync(
			resolve('src/editor/context-provider.tsx'),
			'utf8',
		);
		expect(context).toContain('useUndoRedo(');
		expect(context).toContain('commitTransition(');
	});
});
