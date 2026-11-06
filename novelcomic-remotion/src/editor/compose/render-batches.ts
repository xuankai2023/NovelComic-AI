import {
	COMIC_ERROR_CODES,
	ComicEditorError,
	domainInvariant,
} from '../comic/errors';
import type {OutputBatch} from '../comic/types';
import {toCompositionProps} from '../rendering/to-composition-props';
import type {RenderVideoPayload} from '../rendering/types';
import {validateRenderPayload} from '../rendering/validate-render-payload';
import type {UndoableState} from '../state/types';

export type BatchRenderSubmission = {
	renderId: string;
	bucketName: string;
};

export type BatchRenderSubmitter = (
	payload: RenderVideoPayload,
) => Promise<BatchRenderSubmission>;

export type RenderBatchesInput = {
	project: UndoableState;
	batches: OutputBatch[];
	retryBatchIds?: string[];
	submit: BatchRenderSubmitter;
};

export type RenderBatchResult =
	| {
			batchId: string;
			ok: true;
			renderId: string;
			bucketName: string;
	  }
	| {
			batchId: string;
			ok: false;
			error: ComicEditorError;
	  };

const asDomainError = (error: unknown): ComicEditorError => {
	if (error instanceof ComicEditorError) {
		return error;
	}

	return domainInvariant(
		error instanceof Error ? error.message : 'Batch payload is invalid',
	);
};

const asSubmitError = (error: unknown): ComicEditorError => {
	if (error instanceof ComicEditorError) {
		return error;
	}

	return new ComicEditorError({
		code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
		message:
			error instanceof Error ? error.message : 'Batch render submission failed',
		retryable: true,
		status: 503,
	});
};

const payloadForBatch = (
	project: UndoableState,
	batch: OutputBatch,
): RenderVideoPayload => {
	const inclusive = batch.endFrameInclusive - batch.fromFrame + 1;
	if (
		!Number.isInteger(batch.fromFrame) ||
		!Number.isInteger(batch.endFrameInclusive) ||
		batch.endFrameInclusive < batch.fromFrame ||
		inclusive !== batch.durationInFrames
	) {
		throw domainInvariant(
			`Batch ${batch.batchId} frame range is not inclusive`,
		);
	}

	const props = toCompositionProps(project);
	return {
		compositionWidth: props.compositionWidth,
		compositionHeight: props.compositionHeight,
		fps: props.fps,
		tracks: props.tracks,
		items: props.items,
		assets: props.assets,
		shots: props.shots,
		advanced: props.advanced,
		propertyGraph: props.propertyGraph,
		codec: 'h264',
		frameRange: [batch.fromFrame, batch.endFrameInclusive],
		enforceBatchDuration: true,
	};
};

export const renderBatches = async (
	input: RenderBatchesInput,
): Promise<RenderBatchResult[]> => {
	const ordered = [...input.batches].sort((left, right) => {
		return left.batchIndex - right.batchIndex;
	});
	const retry = input.retryBatchIds;
	const selected = retry
		? ordered.filter((batch) => retry.includes(batch.batchId))
		: ordered;
	const results: RenderBatchResult[] = [];

	for (const batch of selected) {
		let payload: RenderVideoPayload;
		try {
			payload = payloadForBatch(input.project, batch);
			validateRenderPayload(payload);
		} catch (error) {
			results.push({
				batchId: batch.batchId,
				ok: false,
				error: asDomainError(error),
			});
			continue;
		}

		try {
			const submission = await input.submit(payload);
			results.push({
				batchId: batch.batchId,
				ok: true,
				renderId: submission.renderId,
				bucketName: submission.bucketName,
			});
		} catch (error) {
			results.push({
				batchId: batch.batchId,
				ok: false,
				error: asSubmitError(error),
			});
		}
	}

	return results;
};
