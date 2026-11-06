import {describe, expect, it} from 'vitest';
import {
	layerPackageToPsdManifest,
	parsePsdManifest,
	psdManifestToLayerPackage,
	serializePsdManifest,
} from './psd-package';

describe('PSD layer manifest adapter', () => {
	it('round-trips layer order, bounds, visibility, and opacity', () => {
		const layerPackage = {
			schemaVersion: 1 as const,
			projectId: 'project-1',
			shotId: 'shot-1',
			sourceUrl: 'https://cdn.example.com/source.png',
			canvas: {width: 1920, height: 1080},
			layers: [
				{
					layerId: 'hair',
					name: 'Hair',
					semantic: 'hair' as const,
					imageUrl: 'https://cdn.example.com/hair.png',
					zIndex: 3,
					visible: true,
					opacity: 0.8,
					bounds: {x: 100, y: 200, width: 300, height: 400},
					anchor: {x: 0.5, y: 0.5},
					confidence: 1,
					motionPolicy: 'free' as const,
				},
			],
			diagnostics: {
				recompositionScore: 1,
				alphaHoleRatio: 0,
				edgeArtifactScore: 0,
				requiresFallback: false,
				warnings: [],
			},
		};
		const parsed = parsePsdManifest(
			serializePsdManifest(layerPackageToPsdManifest(layerPackage)),
		);
		const restored = psdManifestToLayerPackage({
			manifest: parsed,
			projectId: 'project-1',
			shotId: 'shot-1',
			sourceUrl: 'https://cdn.example.com/source.png',
		});
		expect(restored.layers[0]).toMatchObject({
			layerId: 'hair',
			name: 'Hair',
			zIndex: 3,
			visible: true,
			opacity: 0.8,
			bounds: {x: 100, y: 200, width: 300, height: 400},
		});
	});
});
