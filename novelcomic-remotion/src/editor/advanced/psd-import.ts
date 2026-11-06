import type {LayerPackage} from '../comic/types';
import {psdManifestToLayerPackage} from './psd-package';
import type {PsdImportManifest} from './types';

export type PsdImportInput = {
	manifest: PsdImportManifest;
	projectId: string;
	shotId: string;
	sourceUrl: string;
};

export const importPsdLayerManifest = (input: PsdImportInput): LayerPackage => {
	return psdManifestToLayerPackage({
		manifest: input.manifest,
		projectId: input.projectId,
		shotId: input.shotId,
		sourceUrl: input.sourceUrl,
	});
};
