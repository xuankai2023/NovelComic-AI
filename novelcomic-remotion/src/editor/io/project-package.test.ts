import {describe, expect, it} from 'vitest';
import {createEmptyDocument, createPixelLayer} from '../document';
import {buildProjectPackage, ProjectPackageError, readProjectPackage} from './project-package';

describe('document project package', () => {
	it('round-trips a document and verifies asset bytes', async () => {
		const document = createEmptyDocument({projectId: 'project-1', documentId: 'document-1'});
		const layer = createPixelLayer('asset-1', 'Background', 2, 2); layer.id = 'layer-1'; document.layers[layer.id] = layer; document.rootLayerIds = [layer.id]; document.assets['asset-1'] = {id: 'asset-1', kind: 'raster', originalName: 'background.png', mimeType: 'image/png', byteSize: 4, objectKey: 'assets/asset-1/background.png', contentHash: 'source-hash'};
		const built = await buildProjectPackage({document, assets: [{assetId: 'asset-1', body: new Uint8Array([1, 2, 3, 4])}]});
		const restored = await readProjectPackage(built.body);
		expect(restored.document.projectId).toBe('project-1'); expect(restored.assets.get('asset-1')).toEqual(new Uint8Array([1, 2, 3, 4])); expect(restored.manifest.assets[0]?.path).toContain('assets/asset-1/');
	});
	it('rejects a missing asset instead of replacing the current project', async () => {
		const document = createEmptyDocument({projectId: 'project-1'}); const layer = createPixelLayer('missing', 'Missing'); document.layers[layer.id] = layer; document.rootLayerIds = [layer.id]; document.assets.missing = {id: 'missing', kind: 'raster', originalName: 'missing.png', mimeType: 'image/png', byteSize: 1, objectKey: 'missing', contentHash: 'hash'};
		await expect(buildProjectPackage({document, assets: []})).rejects.toMatchObject({code: 'ASSET_DATA_MISSING'} satisfies Partial<ProjectPackageError>);
	});
});
