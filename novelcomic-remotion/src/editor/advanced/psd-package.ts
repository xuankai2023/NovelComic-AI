import {COMIC_LAYER_SEMANTICS, type LayerPackage} from '../comic/types';
import type {PsdImportManifest} from './types';

export const PSD_MANIFEST_MIME = 'application/vnd.novelcomic.psd-manifest+json';

export const layerPackageToPsdManifest = (
	layerPackage: LayerPackage,
): PsdImportManifest => ({
	format: 'psd-layer-manifest',
	version: 1,
	width: layerPackage.canvas.width,
	height: layerPackage.canvas.height,
	layers: layerPackage.layers.map((layer) => ({
		id: layer.layerId,
		name: layer.name,
		visible: layer.visible,
		opacity: layer.opacity ?? 1,
		zIndex: layer.zIndex,
		bounds: {...layer.bounds},
		imageUrl: layer.imageUrl,
		semantic: layer.semantic,
	})),
	metadata: {
		projectId: layerPackage.projectId,
		shotId: layerPackage.shotId,
		sourceUrl: layerPackage.sourceUrl,
	},
});

export const psdManifestToLayerPackage = ({
	manifest,
	projectId,
	shotId,
	sourceUrl,
}: {
	manifest: PsdImportManifest;
	projectId: string;
	shotId: string;
	sourceUrl: string;
}): LayerPackage => ({
	schemaVersion: 1,
	projectId,
	shotId,
	sourceUrl,
	canvas: {width: manifest.width, height: manifest.height},
	layers: manifest.layers.map((layer) => ({
		layerId: layer.id,
		name: layer.name,
		semantic: COMIC_LAYER_SEMANTICS.includes(
			layer.semantic as LayerPackage['layers'][number]['semantic'],
		)
			? (layer.semantic as LayerPackage['layers'][number]['semantic'])
			: 'other',
		imageUrl: layer.imageUrl,
		opacity: layer.opacity,
		zIndex: layer.zIndex,
		visible: layer.visible,
		bounds: {...layer.bounds},
		anchor: {x: 0.5, y: 0.5},
		confidence: 1,
		motionPolicy: 'static',
	})),
	diagnostics: {
		recompositionScore: 1,
		alphaHoleRatio: 0,
		edgeArtifactScore: 0,
		requiresFallback: false,
		warnings: [],
	},
});

export const serializePsdManifest = (manifest: PsdImportManifest): string =>
	JSON.stringify(manifest, null, 2);

export const parsePsdManifest = (input: string): PsdImportManifest => {
	const value: unknown = JSON.parse(input);
	if (!value || typeof value !== 'object') {
		throw new Error('PSD manifest must be a JSON object');
	}
	const manifest = value as Partial<PsdImportManifest>;
	if (
		manifest.format !== 'psd-layer-manifest' ||
		manifest.version !== 1 ||
		!Number.isInteger(manifest.width) ||
		!Number.isInteger(manifest.height) ||
		!Array.isArray(manifest.layers)
	) {
		throw new Error('Invalid PSD layer manifest');
	}
	const width = manifest.width as number;
	const height = manifest.height as number;
	if (
		width <= 0 ||
		height <= 0 ||
		manifest.layers.some((layer) => {
			if (!layer || typeof layer !== 'object') return true;
			const candidate = layer as Partial<PsdImportManifest['layers'][number]>;
			return (
				typeof candidate.id !== 'string' ||
				typeof candidate.name !== 'string' ||
				typeof candidate.imageUrl !== 'string' ||
				typeof candidate.visible !== 'boolean' ||
				!Number.isFinite(candidate.opacity) ||
				!Number.isInteger(candidate.zIndex) ||
				!candidate.bounds ||
				!Number.isFinite(candidate.bounds.x) ||
				!Number.isFinite(candidate.bounds.y) ||
				!Number.isFinite(candidate.bounds.width) ||
				!Number.isFinite(candidate.bounds.height)
			);
		})
	) {
		throw new Error('Invalid PSD layer manifest layer');
	}
	return manifest as PsdImportManifest;
};
