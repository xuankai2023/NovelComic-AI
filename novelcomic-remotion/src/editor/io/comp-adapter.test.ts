import {describe, expect, it} from 'vitest';
import {compToDocument, documentToComp, parseCompManifest} from './comp-adapter';

describe('Compositor .comp adapter', () => {
	it('imports and exports an image layer and its mask', () => {
		const manifest = {format: 'com.compositor.project', version: 11, colorSpace: 'sRGB', documentID: 'doc-1', width: 2, height: 2, layers: [{id: 'LAYER', name: 'Layer', imageFile: 'LAYER.png', maskFile: 'LAYER.mask.png', transform: {origin: [0, 0], size: [2, 2]}}]};
		const imported = compToDocument({projectId: 'project-1', files: {'manifest.json': JSON.stringify(manifest), 'images/LAYER.png': new Uint8Array([1]), 'images/LAYER.mask.png': new Uint8Array([255])}});
		expect(imported.document.rootLayerIds).toEqual(['LAYER']); expect(imported.report.warnings).toEqual([]);
		const exported = documentToComp({document: imported.document, assets: imported.assets}); expect(parseCompManifest(JSON.parse(String(exported.files['manifest.json']))).layers[0]?.maskFile).toBe('LAYER.mask.png');
	});
	it('rejects unsafe paths before reading files', () => {
		expect(() => parseCompManifest({format: 'com.compositor.project', version: 11, colorSpace: 'sRGB', documentID: 'doc', width: 1, height: 1, layers: [{id: 'layer', name: 'Layer', imageFile: '../secret.png', transform: {origin: [0, 0], size: [1, 1]}}]})).toThrow(/Unsafe/);
	});
});
