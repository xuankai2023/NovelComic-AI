import type {UndoableState} from '../state/types';
import {buildDeliveryManifest} from './delivery-manifest';
import {domainInvariant} from './errors';
import type {
	DeliveryFileEntry,
	DeliveryPackageManifest,
	OutputBatch,
} from './types';

export type FinalizedBatchRender =
	| {
			batchId: string;
			status: 'done';
			outputFile: string;
			outputSizeInBytes?: number;
			checksum?: string;
	  }
	| {
			batchId: string;
			status: 'in-progress';
	  }
	| {
			batchId: string;
			status: 'error';
			error: string;
	  };

export type IncompleteBatch = {
	batchId: string;
	batchIndex: number;
	status: 'missing' | 'in-progress' | 'error';
	retryable: boolean;
	message: string;
};

export type FinalizeBatchDeliveryInput = {
	projectId: string;
	project: UndoableState;
	batches: OutputBatch[];
	renderedBatches: FinalizedBatchRender[];
	files?: DeliveryFileEntry[];
	generatedAt?: string;
};

export type FinalizeBatchDeliveryResult = {
	manifest: DeliveryPackageManifest;
	finalVideoFiles: DeliveryFileEntry[];
	playOrder: string[];
	incompleteBatches: IncompleteBatch[];
};

const finalVideoPath = (batch: OutputBatch): string => {
	return `final-video/${batch.batchId}.mp4`;
};

const withoutFinalVideos = (
	files: readonly DeliveryFileEntry[],
): DeliveryFileEntry[] => {
	return files
		.filter((file) => file.category !== 'final-video')
		.map((file) => ({...file}));
};

const renderedBatchMap = (
	batches: readonly OutputBatch[],
	renderedBatches: readonly FinalizedBatchRender[],
): Map<string, FinalizedBatchRender> => {
	const known = new Set(batches.map((batch) => batch.batchId));
	const rendered = new Map<string, FinalizedBatchRender>();
	for (const result of renderedBatches) {
		if (!known.has(result.batchId)) {
			throw domainInvariant(`Rendered batch ${result.batchId} is unknown`);
		}

		if (rendered.has(result.batchId)) {
			throw domainInvariant(`Rendered batch ${result.batchId} is duplicated`);
		}

		rendered.set(result.batchId, {...result});
	}

	return rendered;
};

const doneFileFor = (
	batch: OutputBatch,
	rendered: FinalizedBatchRender & {status: 'done'},
): DeliveryFileEntry => {
	const file: DeliveryFileEntry = {
		path: finalVideoPath(batch),
		category: 'final-video',
		order: batch.batchIndex,
		url: rendered.outputFile,
	};

	if (rendered.outputSizeInBytes !== undefined) {
		file.sizeBytes = rendered.outputSizeInBytes;
	}

	if (rendered.checksum) {
		file.checksum = rendered.checksum;
	}

	return file;
};

const incompleteFor = (
	batch: OutputBatch,
	rendered: FinalizedBatchRender | undefined,
): IncompleteBatch | null => {
	if (!rendered) {
		return {
			batchId: batch.batchId,
			batchIndex: batch.batchIndex,
			status: 'missing',
			retryable: true,
			message: `Batch ${batch.batchId} has no render result`,
		};
	}

	if (rendered.status === 'done') {
		return null;
	}

	if (rendered.status === 'in-progress') {
		return {
			batchId: batch.batchId,
			batchIndex: batch.batchIndex,
			status: 'in-progress',
			retryable: false,
			message: `Batch ${batch.batchId} is still rendering`,
		};
	}

	return {
		batchId: batch.batchId,
		batchIndex: batch.batchIndex,
		status: 'error',
		retryable: true,
		message: rendered.error,
	};
};

export const finalizeBatchDelivery = (
	input: FinalizeBatchDeliveryInput,
): FinalizeBatchDeliveryResult => {
	const batches = [...input.batches].sort((left, right) => {
		return (
			left.batchIndex - right.batchIndex ||
			left.batchId.localeCompare(right.batchId)
		);
	});
	const rendered = renderedBatchMap(batches, input.renderedBatches);
	const finalVideoFiles: DeliveryFileEntry[] = [];
	const incompleteBatches: IncompleteBatch[] = [];

	for (const batch of batches) {
		const result = rendered.get(batch.batchId);
		const incomplete = incompleteFor(batch, result);
		if (incomplete) {
			incompleteBatches.push(incomplete);
			continue;
		}

		if (result?.status === 'done') {
			finalVideoFiles.push(doneFileFor(batch, result));
		}
	}

	const manifest = buildDeliveryManifest({
		projectId: input.projectId,
		project: input.project,
		batches,
		files: [...withoutFinalVideos(input.files ?? []), ...finalVideoFiles],
		generatedAt: input.generatedAt,
	});

	return {
		manifest,
		finalVideoFiles,
		playOrder: manifest.playOrder,
		incompleteBatches,
	};
};

