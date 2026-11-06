import type {LayerPackage} from '../comic/types';
import {createStoredZip, type ZipEntry} from '../comic/zip';
import {layerPackageToPsdManifest, serializePsdManifest} from './psd-package';

export type PsdExportDependencies = {
	download?: (url: string) => Promise<Buffer>;
	now?: Date;
};

export type PsdExportResult = {
	body: Buffer;
	filename: string;
	manifest: ReturnType<typeof layerPackageToPsdManifest>;
	warnings: string[];
};

const defaultDownload = async (url: string): Promise<Buffer> => {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	return Buffer.from(await response.arrayBuffer());
};

const safeName = (value: string): string =>
	value.replace(/[^a-zA-Z0-9._-]+/g, '-');

export const buildPsdLayerPackage = async (
	layerPackage: LayerPackage,
	dependencies: PsdExportDependencies = {},
): Promise<PsdExportResult> => {
	const manifest = layerPackageToPsdManifest(layerPackage);
	const download = dependencies.download ?? defaultDownload;
	const warnings: string[] = [];
	const entries: ZipEntry[] = [
		{
			path: 'manifest.json',
			body: serializePsdManifest(manifest),
		},
	];

	for (const layer of manifest.layers) {
		try {
			const body = await download(layer.imageUrl);
			entries.push({
				path: `layers/${safeName(layer.id)}.png`,
				body,
			});
		} catch (error) {
			warnings.push(
				`${layer.id}: ${
					error instanceof Error ? error.message : 'download failed'
				}`,
			);
		}
	}

	return {
		body: createStoredZip(entries, dependencies.now),
		filename: `${safeName(layerPackage.shotId)}.psd-layer-package.zip`,
		manifest,
		warnings,
	};
};
