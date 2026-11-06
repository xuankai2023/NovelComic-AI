import {createHash} from 'node:crypto';
import {getCOSReadUrl, putCOSObject} from '../utils/cos-client';
import {
	buildDeliveryManifest,
	type DeliveryManifestSource,
} from './delivery-manifest';
import {buildManualLayerPackage} from './manual-layer-package';
import type {
	ComicLayer,
	DeliveryFileEntry,
	DeliveryPackageManifest,
	LayerPackage,
} from './types';
import {createStoredZip, type ZipEntry} from './zip';

export type DeliveryPackageMissingFile = {
	path: string;
	reason: string;
	url?: string;
};

export type DeliveryPackageResult = {
	deliveryStatus: 'delivery-complete' | 'delivery-incomplete';
	manifest: DeliveryPackageManifest;
	packageKey: string;
	packageUrl: string;
	packageSizeBytes: number;
	packageChecksum: string;
	missingFiles: DeliveryPackageMissingFile[];
	warnings: string[];
};

export type DeliveryPackageDependencies = {
	download?: (url: string) => Promise<Buffer>;
	upload?: (input: {
		key: string;
		body: Buffer;
		contentType: string;
	}) => Promise<void>;
	readUrl?: (key: string) => string;
	now?: () => Date;
};

const defaultDownload = async (url: string): Promise<Buffer> => {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}

	return Buffer.from(await response.arrayBuffer());
};

const projectEntry = (source: DeliveryManifestSource): ZipEntry => {
	return {
		path: 'project/project.json',
		body: JSON.stringify(source.project, null, 2),
	};
};

const manifestEntry = (manifest: DeliveryPackageManifest): ZipEntry => {
	return {
		path: 'manifest.json',
		body: JSON.stringify(manifest, null, 2),
	};
};

const filesEntry = (manifest: DeliveryPackageManifest): ZipEntry => {
	return {
		path: 'files.json',
		body: JSON.stringify(
			{
				playOrder: manifest.playOrder,
				files: manifest.files,
				layerPackages: manifest.layerPackages ?? [],
			},
			null,
			2,
		),
	};
};

const packageKeyFor = (
	projectId: string,
	projectContentHash: string,
): string => {
	const safeProjectId = projectId.replace(/[^a-zA-Z0-9._-]+/g, '-');
	return `deliveries/${safeProjectId}/${projectContentHash}.zip`;
};

const safePathSegment = (value: string): string => {
	return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
};

const layerShotId = (
	project: DeliveryManifestSource['project'],
	layer: NonNullable<
		DeliveryManifestSource['project']['comicEditLayers']
	>[string],
): string | undefined => {
	if (layer.shotId) {
		return layer.shotId;
	}

	if (!layer.sourceItemId) {
		return undefined;
	}

	const sourceItem = project.items[layer.sourceItemId];
	return sourceItem?.type === 'image' ? sourceItem.shotId : undefined;
};

type ManualLayerDelivery = {
	files: DeliveryFileEntry[];
	layerPackages: LayerPackage[];
	warnings: string[];
};

const manualLayerFile = (
	layer: ComicLayer,
	path: string,
): DeliveryFileEntry => {
	return {
		path,
		category: 'layer',
		order: layer.zIndex,
		url: layer.imageUrl,
	};
};

const collectManualLayerDelivery = (
	source: DeliveryManifestSource,
): ManualLayerDelivery => {
	const files: DeliveryFileEntry[] = [];
	const layerPackages: LayerPackage[] = [];
	const warnings: string[] = [];
	const manualLayers = Object.values(source.project.comicEditLayers ?? {});
	const shotIds = new Set(
		manualLayers
			.map((layer) => layerShotId(source.project, layer))
			.filter((shotId): shotId is string => Boolean(shotId)),
	);

	for (const shotId of shotIds) {
		try {
			const layerPackage = buildManualLayerPackage(source.project, shotId);
			layerPackages.push(layerPackage);
			const shotPath = safePathSegment(shotId);

			for (const layer of layerPackage.layers) {
				const layerName = safePathSegment(layer.layerId);
				const basePath = `layers/${shotPath}/${layerName}.png`;
				files.push(manualLayerFile(layer, basePath));
				if (layer.maskUrl) {
					files.push({
						path: `layers/${shotPath}/${layerName}.mask.png`,
						category: 'layer',
						order: layer.zIndex,
						url: layer.maskUrl,
					});
				}
			}
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: 'Could not build layer package';
			warnings.push(`shot ${shotId}: ${message}`);
		}
	}

	return {files, layerPackages, warnings};
};

const checksumFor = (body: Buffer): string => {
	return createHash('sha256').update(body).digest('hex');
};

const shouldDownloadFile = (file: DeliveryFileEntry): boolean => {
	return Boolean(file.url && !file.missingReason);
};

const missingFromManifest = (
	file: DeliveryFileEntry,
): DeliveryPackageMissingFile | null => {
	if (!file.missingReason) {
		return null;
	}

	return {
		path: file.path,
		reason: file.missingReason,
		...(file.url ? {url: file.url} : {}),
	};
};

const isRequiredMissingFile = (
	project: DeliveryManifestSource['project'],
	missing: DeliveryPackageMissingFile,
): boolean => {
	if (!missing.path.startsWith('missing/')) return true;
	const category = missing.path.slice('missing/'.length);
	if (category === 'project' || category === 'preview') return false;
	if (category === 'layer') {
		return Object.keys(project.comicEditLayers ?? {}).length > 0;
	}
	if (category === 'audio') {
		return Object.values(project.assets).some((asset) => asset.type === 'audio');
	}
	if (category === 'subtitle') {
		return (
			Object.values(project.assets).some((asset) => asset.type === 'caption') ||
			Object.values(project.items).some((item) => item.type === 'captions')
		);
	}
	if (category === 'source') {
		return Object.values(project.assets).some(
			(asset) => asset.type !== 'audio' && asset.type !== 'caption',
		);
	}
	return true;
};

export const buildDeliveryPackage = async (
	source: DeliveryManifestSource,
	dependencies: DeliveryPackageDependencies = {},
): Promise<DeliveryPackageResult> => {
	const generatedAt = source.generatedAt ?? dependencies.now?.().toISOString();
	const manualDelivery = collectManualLayerDelivery(source);
	const manualPaths = new Set(manualDelivery.files.map((file) => file.path));
	const manifest = buildDeliveryManifest({
		...source,
		...(generatedAt ? {generatedAt} : {}),
		files: [...source.files, ...manualDelivery.files],
		layerPackages: manualDelivery.layerPackages,
	});
	const downloadableManualFiles = manifest.files.map((file) => {
		if (
			manualPaths.has(file.path) &&
			file.url &&
			file.missingReason === 'Missing checksum'
		) {
			const withoutMissingReason = {...file};
			delete withoutMissingReason.missingReason;
			return withoutMissingReason;
		}

		return file;
	});
	manifest.files = downloadableManualFiles;
	// A caller may only know the remote URL. The package builder is the
	// trusted download boundary, so it can calculate the checksum after the
	// bytes arrive instead of dropping an otherwise valid delivery file.
	for (const file of manifest.files) {
		if (file.url && file.missingReason === 'Missing checksum') {
			delete file.missingReason;
		}
	}
	const download = dependencies.download ?? defaultDownload;
	const upload = dependencies.upload ?? putCOSObject;
	const readUrl = dependencies.readUrl ?? getCOSReadUrl;
	const missingFiles: DeliveryPackageMissingFile[] = [];
	const warnings: string[] = [...manualDelivery.warnings];
	const entries: ZipEntry[] = [projectEntry(source)];

	for (const file of manifest.files) {
		const manifestMissing = missingFromManifest(file);
		if (manifestMissing) {
			missingFiles.push(manifestMissing);
			continue;
		}

		if (!shouldDownloadFile(file)) {
			missingFiles.push({
				path: file.path,
				reason: 'Missing file URL',
			});
			continue;
		}

		try {
			const body = await download(file.url!);
			entries.push({
				path: file.path,
				body,
			});
			if (manualPaths.has(file.path) || !file.checksum) {
				file.checksum = checksumFor(body);
				file.sizeBytes = body.length;
			}
		} catch (error) {
			const reason =
				error instanceof Error
					? `Could not download file: ${error.message}`
					: 'Could not download file';
			missingFiles.push({
				path: file.path,
				reason,
				url: file.url,
			});
			warnings.push(`${file.path}: ${reason}`);
		}
	}

	entries.push(manifestEntry(manifest), filesEntry(manifest));
	const zip = createStoredZip(
		entries,
		generatedAt ? new Date(generatedAt) : undefined,
	);
	const packageKey = packageKeyFor(
		source.projectId,
		manifest.projectContentHash,
	);
	await upload({
		key: packageKey,
		body: zip,
		contentType: 'application/zip',
	});
	const hasFullVideo = manifest.files.some(
		(file) =>
			file.path === 'final-video/full.mp4' &&
			file.category === 'final-video' &&
			Boolean(file.url) &&
			Boolean(file.checksum) &&
			!file.missingReason &&
			!missingFiles.some((missing) => missing.path === file.path),
	);
	const snapshotMatchesProject =
		Boolean(source.inputSnapshotId) &&
		Boolean(source.inputContentHash) &&
		Boolean(source.preflightHash) &&
		source.inputContentHash === manifest.projectContentHash;
	const blockingMissingFiles = missingFiles.filter((missing) =>
		isRequiredMissingFile(source.project, missing),
	);
	const deliveryStatus =
		blockingMissingFiles.length === 0 && hasFullVideo && snapshotMatchesProject
			? 'delivery-complete'
			: 'delivery-incomplete';
	if (!hasFullVideo) {
		warnings.push('A merged final-video/full.mp4 is required for complete delivery.');
	}
	if (!snapshotMatchesProject) {
		warnings.push(
			'Delivery input snapshot/hash is missing or does not match the packaged project.',
		);
	}

	return {
		deliveryStatus,
		manifest,
		packageKey,
		packageUrl: readUrl(packageKey),
		packageSizeBytes: zip.length,
		packageChecksum: checksumFor(zip),
		missingFiles,
		warnings,
	};
};
