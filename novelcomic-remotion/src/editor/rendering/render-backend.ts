import {
	getRenderProgress,
	renderMediaOnLambda,
	speculateFunctionName,
} from '@remotion/lambda/client';
import type {CancelSignal} from '@remotion/renderer';
import {
	COMP_NAME,
	DISK_SIZE_IN_MB,
	MEM_SIZE_IN_MB,
	SITE_NAME,
	TIMEOUT_IN_SECONDS,
} from '../../remotion/constants';
import {getEditorExportFileName} from '../utils/export-file-name';
import {
	getServerEnv,
	renderBackend,
	requireServerEnv,
} from '../utils/server-env';
import {
	beginLocalRender,
	cancelLocalRender,
	LOCAL_RENDER_BUCKET,
	localProgressResponse,
} from './local-render-jobs';
import {toCompositionProps} from './to-composition-props';
import type {
	CancelRenderResponse,
	GetProgressResponse,
	RenderVideoPayload,
} from './types';

export type RenderBackendHandle = {
	renderId: string;
	bucketName: string;
};

export type RenderBackendProgress = GetProgressResponse;

export type RenderBackendAdapter = {
	backend: 'local' | 'lambda';
	submit: (
		payload: RenderVideoPayload,
		options?: {cancelSignal?: CancelSignal},
	) => Promise<RenderBackendHandle>;
	getProgress: (
		handle: RenderBackendHandle,
		options?: {startedAt?: number; signal?: AbortSignal},
	) => Promise<RenderBackendProgress>;
	cancel: (handle: RenderBackendHandle) => Promise<CancelRenderResponse>;
};

export type RenderBackendCapabilities = {
	renderBackend: 'local' | 'lambda';
	local: {available: boolean; reason?: string};
	lambda: {configured: boolean; reason?: string};
};

/** Safe preflight data for the UI; credentials are intentionally omitted. */
export const getRenderBackendCapabilities = (): RenderBackendCapabilities => {
	const backend = renderBackend();
	const env = getServerEnv();
	const lambdaConfigured = Boolean(
		env.REMOTION_AWS_BUCKET_NAME && env.REMOTION_AWS_REGION,
	);
	return {
		renderBackend: backend,
		local:
			backend === 'local'
				? {available: true}
				: {available: false, reason: 'REMOTION_RENDER_BACKEND is not local.'},
		lambda: lambdaConfigured
			? {configured: true}
			: {
					configured: false,
					reason: 'Remotion Lambda bucket and region are not configured.',
				},
	};
};

const lambdaFunctionName = () =>
	speculateFunctionName({
		diskSizeInMb: DISK_SIZE_IN_MB,
		memorySizeInMb: MEM_SIZE_IN_MB,
		timeoutInSeconds: TIMEOUT_IN_SECONDS,
	});

type LambdaProgress = Awaited<ReturnType<typeof getRenderProgress>>;

const toLambdaProgress = (progress: LambdaProgress): RenderBackendProgress => {
	if (progress.done) {
		const outputName =
			(progress.renderMetadata?.downloadBehavior.type === 'download'
				? progress.renderMetadata.downloadBehavior.fileName
				: null) ?? (progress.outKey as string);
		return {
			type: 'done',
			outputFile: progress.outputFile as string,
			outputSizeInBytes: progress.outputSizeInBytes as number,
			outputName,
		};
	}
	if (progress.fatalErrorEncountered) {
		return {
			type: 'error',
			error: progress.errors[0]?.message ?? 'Lambda render failed',
			retryable: false,
		};
	}
	return {type: 'in-progress', overallProgress: progress.overallProgress};
};

const localAdapter: RenderBackendAdapter = {
	backend: 'local',
	submit: async (payload, options) => {
		return beginLocalRender(payload, options);
	},
	getProgress: async (handle) => localProgressResponse(handle.renderId),
	cancel: async (handle) => cancelLocalRender(handle.renderId),
};

/**
 * Remotion 4 exposes `deleteRender()` but not a stop-render API. Newer
 * deployments can expose a stop function or an internal cancel endpoint. We
 * feature-detect both and return CANCEL_UNSUPPORTED otherwise; this is safer
 * than claiming a Lambda invocation was canceled when it is still running.
 */
const cancelLambdaRender = async (
	handle: RenderBackendHandle,
): Promise<CancelRenderResponse> => {
	const cancelUrl = process.env.REMOTION_LAMBDA_CANCEL_URL;
	if (cancelUrl) {
		const response = await fetch(cancelUrl, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(handle),
		});
		if (response.status === 409 || response.status === 501) {
			return {
				type: 'unsupported',
				code: 'CANCEL_UNSUPPORTED',
				message:
					'Lambda render cancellation is not supported by this deployment.',
			};
		}
		if (!response.ok) {
			return {
				type: 'error',
				code: `LAMBDA_CANCEL_${response.status}`,
				message: `Lambda cancel failed with status ${response.status}.`,
				retryable: response.status >= 500,
			};
		}
		return (await response.json()) as CancelRenderResponse;
	}

	const lambdaClient =
		(await import('@remotion/lambda/client')) as typeof import('@remotion/lambda/client') & {
			stopRender?: (input: {
				region: ReturnType<typeof requireServerEnv>['REMOTION_AWS_REGION'];
				bucketName: string;
				renderId: string;
				functionName: string;
			}) => Promise<unknown>;
		};
	if (typeof lambdaClient.stopRender !== 'function') {
		return {
			type: 'unsupported',
			code: 'CANCEL_UNSUPPORTED',
			message:
				'Lambda render cancellation is not supported by this Remotion version.',
		};
	}

	const env = getServerEnv();
	if (!env.REMOTION_AWS_REGION || !env.REMOTION_AWS_BUCKET_NAME) {
		return {
			type: 'unsupported',
			code: 'CANCEL_UNSUPPORTED',
			message:
				'Lambda render cancellation is unavailable until Lambda is configured.',
		};
	}
	await lambdaClient.stopRender({
		region: env.REMOTION_AWS_REGION,
		bucketName: handle.bucketName,
		renderId: handle.renderId,
		functionName: lambdaFunctionName(),
	});
	return {type: 'canceled'};
};

const lambdaAdapter: RenderBackendAdapter = {
	backend: 'lambda',
	submit: async (payload) => {
		const serverEnv = requireServerEnv();
		const {bucketName, renderId} = await renderMediaOnLambda({
			codec: 'h264',
			inputProps: toCompositionProps(payload),
			composition: COMP_NAME,
			functionName: lambdaFunctionName(),
			colorSpace: 'bt709',
			region: serverEnv.REMOTION_AWS_REGION,
			serveUrl: SITE_NAME,
			downloadBehavior: {
				fileName: getEditorExportFileName('h264'),
				type: 'download',
			},
			timeoutInMilliseconds: 120000,
			...(payload.frameRange ? {frameRange: payload.frameRange} : {}),
		});
		return {renderId, bucketName};
	},
	getProgress: async (handle, options) => {
		const env = requireServerEnv();
		const progress = await getRenderProgress({
			bucketName: handle.bucketName,
			renderId: handle.renderId,
			functionName: lambdaFunctionName(),
			region: env.REMOTION_AWS_REGION,
			skipLambdaInvocation: false,
			...(options?.signal ? {requestHandler: undefined} : {}),
		});
		return toLambdaProgress(progress);
	},
	cancel: cancelLambdaRender,
};

export const getRenderBackendAdapter = (
	backend: 'local' | 'lambda' = renderBackend(),
): RenderBackendAdapter => (backend === 'local' ? localAdapter : lambdaAdapter);

export const getRenderBackendForHandle = (
	handle: RenderBackendHandle,
): RenderBackendAdapter =>
	getRenderBackendAdapter(
		handle.bucketName === LOCAL_RENDER_BUCKET ? 'local' : 'lambda',
	);
