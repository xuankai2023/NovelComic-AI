import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {getCOSReadUrl, putCOSObject} from '../utils/cos-client';
import type {UndoableState} from '../state/types';
import {projectContentHash} from './content-hash';
import {
	COMIC_ERROR_CODES,
	ComicEditorError,
	domainInvariant,
} from './errors';
import type {FinalizedBatchRender} from './finalize-batches';
import type {DeliveryFileEntry, OutputBatch} from './types';

const execFileAsync = promisify(execFile);
const FINAL_VIDEO_PATH = 'final-video/full.mp4';

export type MergeBatchVideosInput = {
	projectId: string;
	project: UndoableState;
	batches: readonly OutputBatch[];
	renderedBatches: readonly FinalizedBatchRender[];
};

export type MergeBatchVideosResult = {
	file: DeliveryFileEntry;
	batchIds: string[];
};

export type MergeBatchVideosDependencies = {
	download?: (url: string) => Promise<Buffer>;
	upload?: (input: {
		key: string;
		body: Buffer;
		contentType: string;
	}) => Promise<void>;
	readUrl?: (key: string) => string;
	runFfmpeg?: (
		inputPaths: readonly string[],
		outputPath: string,
	) => Promise<void>;
};

const dependencyUnavailable = (message: string): ComicEditorError =>
	new ComicEditorError({
		code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
		message,
		retryable: true,
		status: 503,
	});

const safeProjectId = (value: string): string =>
	value.replace(/[^a-zA-Z0-9._-]+/g, '-');

const isHttpsUrl = (value: string): boolean => {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
};

const defaultDownload = async (url: string): Promise<Buffer> => {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}

	return Buffer.from(await response.arrayBuffer());
};

const quotedConcatPath = (value: string): string =>
	`'${value.replaceAll("'", "'\\''")}'`;

const runFfmpeg = async (
	inputPaths: readonly string[],
	outputPath: string,
): Promise<void> => {
	const listPath = `${outputPath}.concat.txt`;
	const list = `${inputPaths
		.map((inputPath) => `file ${quotedConcatPath(inputPath)}`)
		.join('\n')}\n`;
	await writeFile(listPath, list, 'utf8');

	const executable = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
	const commonArgs = [
		'-hide_banner',
		'-loglevel',
		'error',
		'-f',
		'concat',
		'-safe',
		'0',
		'-i',
		listPath,
		'-movflags',
		'+faststart',
	];

	try {
		await execFileAsync(executable, [
			...commonArgs,
			'-c',
			'copy',
			outputPath,
		]);
	} catch (copyError) {
		try {
			await execFileAsync(executable, [
				...commonArgs,
				'-c:v',
				'libx264',
				'-pix_fmt',
				'yuv420p',
				'-c:a',
				'aac',
				outputPath,
			]);
		} catch (reencodeError) {
			const message =
				reencodeError instanceof Error
					? reencodeError.message
					: copyError instanceof Error
						? copyError.message
						: 'ffmpeg failed';
			throw new Error(message);
		}
	}
};

const doneRenderMap = (
	batches: readonly OutputBatch[],
	renderedBatches: readonly FinalizedBatchRender[],
): Map<string, Extract<FinalizedBatchRender, {status: 'done'}>> => {
	const knownBatchIds = new Set(batches.map((batch) => batch.batchId));
	const rendered = new Map<
		string,
		Extract<FinalizedBatchRender, {status: 'done'}>
	>();

	for (const result of renderedBatches) {
		if (!knownBatchIds.has(result.batchId)) {
			throw domainInvariant(`Rendered batch ${result.batchId} is unknown`);
		}
		if (rendered.has(result.batchId)) {
			throw domainInvariant(`Rendered batch ${result.batchId} is duplicated`);
		}
		if (result.status !== 'done') {
			throw domainInvariant(
				result.status === 'error'
					? `Batch ${result.batchId} failed: ${result.error}`
					: `Batch ${result.batchId} is still rendering`,
			);
		}
		if (!isHttpsUrl(result.outputFile)) {
			throw domainInvariant(
				`Batch ${result.batchId} output file must use HTTPS`,
			);
		}
		rendered.set(result.batchId, result);
	}

	for (const batch of batches) {
		if (!rendered.has(batch.batchId)) {
			throw domainInvariant(
				`Batch ${batch.batchId} has no completed render result`,
			);
		}
	}

	return rendered;
};

export const mergeBatchVideos = async (
	input: MergeBatchVideosInput,
	dependencies: MergeBatchVideosDependencies = {},
): Promise<MergeBatchVideosResult> => {
	if (input.batches.length === 0) {
		throw domainInvariant('Cannot merge an empty batch plan');
	}

	const batches = [...input.batches].sort(
		(left, right) =>
			left.batchIndex - right.batchIndex ||
			left.batchId.localeCompare(right.batchId),
	);
	const rendered = doneRenderMap(batches, input.renderedBatches);
	const download = dependencies.download ?? defaultDownload;
	const upload = dependencies.upload ?? putCOSObject;
	const readUrl = dependencies.readUrl ?? getCOSReadUrl;
	const workspace = await mkdtemp(
		path.join(os.tmpdir(), 'novelcomic-batch-merge-'),
	);

	try {
		const inputPaths: string[] = [];
		for (const [index, batch] of batches.entries()) {
			const result = rendered.get(batch.batchId)!;
			let body: Buffer;
			try {
				body = await download(result.outputFile);
			} catch (error) {
				throw dependencyUnavailable(
					`Could not download batch ${batch.batchId}: ${
						error instanceof Error ? error.message : 'unknown error'
					}`,
				);
			}

			const inputPath = path.join(
				workspace,
				`${String(index + 1).padStart(4, '0')}-${safeProjectId(batch.batchId)}.mp4`,
			);
			await writeFile(inputPath, body);
			inputPaths.push(inputPath);
		}

		const outputPath = path.join(workspace, 'full.mp4');
		try {
			await (dependencies.runFfmpeg ?? runFfmpeg)(inputPaths, outputPath);
		} catch (error) {
			throw dependencyUnavailable(
				`Could not merge batch videos: ${
					error instanceof Error ? error.message : 'ffmpeg failed'
				}`,
			);
		}

		let output: Buffer;
		try {
			output = await readFile(outputPath);
		} catch (error) {
			throw dependencyUnavailable(
				`Merged video was not produced: ${
					error instanceof Error ? error.message : 'output file is missing'
				}`,
			);
		}

		const checksum = createHash('sha256').update(output).digest('hex');
		const projectHash = projectContentHash(input.project);
		const key = `deliveries/${safeProjectId(input.projectId)}/${projectHash}/final-video/full.mp4`;
		try {
			await upload({
				key,
				body: output,
				contentType: 'video/mp4',
			});
		} catch (error) {
			throw dependencyUnavailable(
				`Could not upload merged video: ${
					error instanceof Error ? error.message : 'upload failed'
				}`,
			);
		}

		let url: string;
		try {
			url = readUrl(key);
		} catch (error) {
			throw dependencyUnavailable(
				`Could not create merged video URL: ${
					error instanceof Error ? error.message : 'CDN URL is unavailable'
				}`,
			);
		}

		return {
			file: {
				path: FINAL_VIDEO_PATH,
				category: 'final-video',
				order: 0,
				url,
				checksum,
				sizeBytes: output.length,
			},
			batchIds: batches.map((batch) => batch.batchId),
		};
	} finally {
		await rm(workspace, {recursive: true, force: true});
	}
};
