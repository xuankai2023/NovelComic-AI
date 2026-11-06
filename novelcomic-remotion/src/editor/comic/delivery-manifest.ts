import type {UndoableState} from '../state/types';
import {projectContentHash} from './content-hash';
import type {
	DeliveryFileCategory,
	DeliveryFileEntry,
	DeliveryPackageManifest,
	LayerPackage,
	OutputBatch,
} from './types';

export type DeliveryManifestSource = {
	projectId: string;
	project: UndoableState;
	batches: OutputBatch[];
	files: DeliveryFileEntry[];
	layerPackages?: LayerPackage[];
	generatedAt?: string;
	inputSnapshotId?: string;
	inputRevision?: number;
	inputContentHash?: string;
	preflightHash?: string;
};

const REQUIRED_CATEGORIES: readonly DeliveryFileCategory[] = [
	'source',
	'layer',
	'audio',
	'subtitle',
	'project',
	'preview',
];

const copyFile = (file: DeliveryFileEntry): DeliveryFileEntry => {
	const next: DeliveryFileEntry = {
		path: file.path,
		category: file.category,
		order: file.order,
	};

	if (file.url) {
		next.url = file.url;
	}

	if (file.checksum) {
		next.checksum = file.checksum;
	}

	if (file.sizeBytes !== undefined) {
		next.sizeBytes = file.sizeBytes;
	}

	if (file.missingReason) {
		next.missingReason = file.missingReason;
	} else if (!next.url) {
		next.missingReason = 'Missing file';
	} else if (!next.checksum) {
		next.missingReason = 'Missing checksum';
	}

	return next;
};

const categoryRank = (category: DeliveryFileCategory): number => {
	if (category === 'final-video') {
		return REQUIRED_CATEGORIES.length;
	}

	const index = REQUIRED_CATEGORIES.indexOf(category);
	return index === -1 ? REQUIRED_CATEGORIES.length + 1 : index;
};

const compareFiles = (
	left: DeliveryFileEntry,
	right: DeliveryFileEntry,
): number => {
	return (
		categoryRank(left.category) - categoryRank(right.category) ||
		left.order - right.order ||
		left.path.localeCompare(right.path)
	);
};

const copyBatch = (batch: OutputBatch): OutputBatch => {
	return {
		...batch,
		shotIds: [...batch.shotIds],
	};
};

export const buildDeliveryManifest = (
	source: DeliveryManifestSource,
): DeliveryPackageManifest => {
	const files = source.files.map(copyFile);
	const batches = [...source.batches]
		.sort((left, right) => {
			return (
				left.batchIndex - right.batchIndex ||
				left.batchId.localeCompare(right.batchId)
			);
		})
		.map(copyBatch);

	for (const category of REQUIRED_CATEGORIES) {
		if (files.some((file) => file.category === category)) {
			continue;
		}

		files.push({
			path: `missing/${category}`,
			category,
			order: 0,
			missingReason: `Missing ${category}`,
		});
	}

	for (const batch of batches) {
		const covered = files.some((file) => {
			return file.category === 'final-video' && file.order === batch.batchIndex;
		});
		if (covered) {
			continue;
		}

		files.push({
			path: `final-video/${batch.batchId}.mp4`,
			category: 'final-video',
			order: batch.batchIndex,
			missingReason: `Missing final video for batch ${batch.batchId}`,
		});
	}

	if (
		batches.length === 0 &&
		!files.some((file) => file.category === 'final-video')
	) {
		files.push({
			path: 'missing/final-video',
			category: 'final-video',
			order: 0,
			missingReason: 'Missing final video',
		});
	}

	files.sort(compareFiles);
	const playOrder = files
		.filter((file) => file.category === 'final-video')
		.map((file) => file.path);

	return {
		schemaVersion: 1,
		projectId: source.projectId,
		generatedAt: source.generatedAt ?? new Date().toISOString(),
		projectContentHash: projectContentHash(source.project),
		...(source.inputSnapshotId
			? {
					inputSnapshotId: source.inputSnapshotId,
					...(source.inputRevision !== undefined
						? {inputRevision: source.inputRevision}
						: {}),
					...(source.inputContentHash
						? {inputContentHash: source.inputContentHash}
						: {}),
					...(source.preflightHash
						? {preflightHash: source.preflightHash}
						: {}),
				}
			: {}),
		playOrder,
		batches,
		files,
		...(source.layerPackages && source.layerPackages.length > 0
			? {layerPackages: source.layerPackages}
			: {}),
	};
};
