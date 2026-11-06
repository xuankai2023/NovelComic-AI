import {
	getRenderProgress,
	speculateFunctionName,
} from '@remotion/lambda/client';
import {
	LOCAL_RENDER_BUCKET,
	localProgressResponse,
} from '../../../src/editor/rendering/local-render-jobs';
import {
	GetProgressPayload,
	GetProgressResponse,
	RenderCostInfo,
} from '../../../src/editor/rendering/types';
import {
	getCOSReadUrl,
	putCOSObject,
} from '../../../src/editor/utils/cos-client';
import {createHash} from 'node:crypto';
import {requireServerEnv} from '../../../src/editor/utils/server-env';
import {
	DISK_SIZE_IN_MB,
	MEM_SIZE_IN_MB,
	TIMEOUT_IN_SECONDS,
} from '../../../src/remotion/constants';

export const runtime = 'nodejs';

/** Hard cap so a slow Vercel→COS upload cannot burn the whole 300s function budget. */
const COS_COPY_TIMEOUT_MS = 30_000;

const formatMs = (ms: number) => `${Math.round(ms)}ms`;
const formatPct = (value: number) => `${Math.round(value * 1000) / 10}%`;

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function copyLambdaOutputToCOS(sourceUrl: string, destKey: string) {
	const startedAt = Date.now();
	// eslint-disable-next-line no-console
	console.log(
		`[Render COS Copy Start] destKey=${destKey} timeoutMs=${COS_COPY_TIMEOUT_MS}`,
	);

	return await withTimeout(
		(async () => {
			const response = await fetch(sourceUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch render output: ${response.status}`);
			}

			const contentType = response.headers.get('content-type') ?? 'video/mp4';
			const contentLength = Number(response.headers.get('content-length') ?? 0);
			const downloadStartedAt = Date.now();
			const arrayBuffer = await response.arrayBuffer();
			const downloadedBytes = arrayBuffer.byteLength;
			const checksum = createHash('sha256')
				.update(Buffer.from(arrayBuffer))
				.digest('hex');
			const downloadMs = Date.now() - downloadStartedAt;
			const uploadStartedAt = Date.now();
			await putCOSObject({
				key: destKey,
				body: Buffer.from(arrayBuffer),
				contentType,
			});
			const uploadMs = Date.now() - uploadStartedAt;

			// eslint-disable-next-line no-console
			console.log(
				`[Render COS Copy Done] destKey=${destKey}` +
					` | bytes=${downloadedBytes}` +
					` | contentLength=${contentLength || 'unknown'}` +
					` | downloadMs=${formatMs(downloadMs)}` +
					` | uploadMs=${formatMs(uploadMs)}` +
					` | totalMs=${formatMs(Date.now() - startedAt)}`,
			);
			return {checksum};
		})(),
		COS_COPY_TIMEOUT_MS,
		'Render COS copy',
	);
}

export async function POST(request: Request) {
	const requestStartedAt = Date.now();
	try {
		const body = (await request.json()) as GetProgressPayload;

		if (typeof body.bucketName !== 'string') {
			throw new Error('bucketName is not set');
		}

		if (typeof body.renderId !== 'string') {
			throw new Error('renderId is not set');
		}

		if (body.bucketName === LOCAL_RENDER_BUCKET) {
			return Response.json(localProgressResponse(body.renderId));
		}

		const serverEnv = requireServerEnv();

		const progress = await getRenderProgress({
			bucketName: body.bucketName,
			renderId: body.renderId,
			functionName: speculateFunctionName({
				diskSizeInMb: DISK_SIZE_IN_MB,
				memorySizeInMb: MEM_SIZE_IN_MB,
				timeoutInSeconds: TIMEOUT_IN_SECONDS,
			}),
			region: serverEnv.REMOTION_AWS_REGION,
			skipLambdaInvocation: false,
		});
		const getProgressMs = Date.now() - requestStartedAt;
		const lambdaElapsedMs =
			typeof body.startedAt === 'number' ? Date.now() - body.startedAt : null;

		const costs: RenderCostInfo | undefined = progress.costs
			? {
					price: progress.costs.accruedSoFar,
					displayCost: progress.costs.displayCost,
					currency: progress.costs.currency,
					disclaimer: progress.costs.disclaimer,
					estimatedBillingDurationInMs:
						progress.estimatedBillingDurationInMilliseconds ?? 0,
				}
			: undefined;

		if (progress.done) {
			let outputFile = progress.outputFile as string;
			const outputName =
				(progress.renderMetadata?.downloadBehavior.type === 'download'
					? progress.renderMetadata.downloadBehavior.fileName
					: null) ?? (progress.outKey as string);

			const destKey = `renders/${body.renderId}/${outputName}`;
			// eslint-disable-next-line no-console
			console.log(
				`[Render Lambda Done] renderId=${body.renderId}` +
					` | lambdaElapsedMs=${lambdaElapsedMs ? formatMs(lambdaElapsedMs) : 'unknown'}` +
					` | getProgressMs=${formatMs(getProgressMs)}` +
					` | outputSize=${progress.outputSizeInBytes ?? 'unknown'}B` +
					` | outputName=${outputName}`,
			);

			const cosCopyStartedAt = Date.now();
			let checksum: string | undefined;
			try {
				({checksum} = await copyLambdaOutputToCOS(outputFile, destKey));
				outputFile = getCOSReadUrl(destKey);
			} catch (copyErr) {
				// eslint-disable-next-line no-console
				console.warn(
					'Failed to copy render output to COS, using original URL:',
					copyErr,
				);
			}
			const cosCopyMs = Date.now() - cosCopyStartedAt;

			// eslint-disable-next-line no-console
			console.log(
				`[Render Done] renderId=${body.renderId}` +
					` | lambdaElapsedMs=${lambdaElapsedMs ? formatMs(lambdaElapsedMs) : 'unknown'}` +
					` | cosCopyMs=${formatMs(cosCopyMs)}` +
					` | cost=${costs?.displayCost ?? 'N/A'}` +
					` | billingDuration=${costs?.estimatedBillingDurationInMs ?? 0}ms` +
					` | outputSize=${progress.outputSizeInBytes}B`,
			);

			const response: GetProgressResponse = {
				type: 'done',
				outputFile,
				outputSizeInBytes: progress.outputSizeInBytes as number,
				outputName,
				checksum,
				costs,
			};

			return Response.json(response);
		}

		// eslint-disable-next-line no-console
		console.log(
			`[Render Progress] renderId=${body.renderId}` +
				` | progress=${formatPct(progress.overallProgress)}` +
				` | lambdaElapsedMs=${lambdaElapsedMs ? formatMs(lambdaElapsedMs) : 'unknown'}` +
				` | getProgressMs=${formatMs(getProgressMs)}` +
				` | estimatedBilling=${progress.estimatedBillingDurationInMilliseconds ?? 0}ms`,
		);

		if (progress.fatalErrorEncountered) {
			const response: GetProgressResponse = {
				type: 'error',
				error: progress.errors[0].message,
			};

			return Response.json(response);
		}

		const response: GetProgressResponse = {
			type: 'in-progress',
			overallProgress: progress.overallProgress,
			costs,
		};

		return Response.json(response);
	} catch (error) {
		// eslint-disable-next-line no-console
		console.error('Progress API error:', error);
		return Response.json(
			{
				type: 'error',
				error:
					error instanceof Error
						? error.message
						: 'Progress service unavailable',
			} as GetProgressResponse,
			{status: 500},
		);
	}
}
