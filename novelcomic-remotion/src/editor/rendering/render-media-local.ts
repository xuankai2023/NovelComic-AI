import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import type {CancelSignal} from '@remotion/renderer';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {COMP_NAME} from '../../remotion/constants';
import {getCOSReadUrl, putCOSObject} from '../utils/cos-client';
import {getEditorExportFileName} from '../utils/export-file-name';
import {toCompositionProps} from './to-composition-props';
import type {RenderVideoPayload} from './types';
import {validateRenderPayload} from './validate-render-payload';

export type LocalRenderRequest = {
	renderId: string;
	payload: RenderVideoPayload;
	onProgress?: (progress: number) => void;
	cancelSignal?: CancelSignal;
};

export type LocalRenderOutput = {
	outputFile: string;
	outputSizeInBytes: number;
	outputName: string;
	checksum?: string;
};

let bundleTask: Promise<string> | null = null;

const entryPoint = (): string => {
	return path.resolve(process.cwd(), 'src/remotion/index.ts');
};

const bundledServeUrl = (): Promise<string> => {
	if (!bundleTask) {
		bundleTask = bundle({entryPoint: entryPoint()}).catch((error: unknown) => {
			bundleTask = null;
			throw error;
		});
	}

	return bundleTask;
};

const httpsCdnUrl = (key: string): string => {
	const raw = getCOSReadUrl(key);
	const withScheme = raw.startsWith('https://')
		? raw
		: raw.startsWith('http://')
			? `https://${raw.slice('http://'.length)}`
			: `https://${raw.replace(/^\/+/, '')}`;
	if (!withScheme.startsWith('https://') || withScheme.includes('?')) {
		throw new Error('render outputFile must be a stable HTTPS CDN URL');
	}

	return withScheme;
};

export const renderMediaLocal = async (
	request: LocalRenderRequest,
): Promise<LocalRenderOutput> => {
	validateRenderPayload(request.payload);
	const directory = await mkdtemp(path.join(os.tmpdir(), 'comic-render-'));
	const outputName = getEditorExportFileName('h264');
	const outputLocation = path.join(directory, outputName);

	try {
		const serveUrl = await bundledServeUrl();
		const inputProps = toCompositionProps(request.payload) as Record<
			string,
			unknown
		>;
		const composition = await selectComposition({
			serveUrl,
			id: COMP_NAME,
			inputProps,
		});
		await renderMedia({
			composition,
			serveUrl,
			codec: 'h264',
			outputLocation,
			inputProps,
			colorSpace: 'bt709',
			cancelSignal: request.cancelSignal,
			timeoutInMilliseconds: 600000,
			...(request.payload.frameRange
				? {frameRange: request.payload.frameRange}
				: {}),
			onProgress: ({progress}) => {
				request.onProgress?.(progress);
			},
		});
		const body = await readFile(outputLocation);
		const key = `renders/${request.renderId}/${outputName}`;
		await putCOSObject({
			key,
			body,
			contentType: 'video/mp4',
		});
		return {
			outputFile: httpsCdnUrl(key),
			outputSizeInBytes: body.length,
			outputName,
			checksum: createHash('sha256').update(body).digest('hex'),
		};
	} finally {
		await rm(directory, {recursive: true, force: true});
	}
};
