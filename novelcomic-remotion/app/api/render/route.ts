import {submitRender} from '../../../src/editor/rendering/submit-render';
import {RenderVideoResponse} from '../../../src/editor/rendering/types';
import {validateRenderPayload} from '../../../src/editor/rendering/validate-render-payload';
import {getCompositionDuration} from '../../../src/editor/utils/get-composition-duration';
import {renderBackend} from '../../../src/editor/utils/server-env';
import {validateProject} from '../../../src/editor/comic/validate-project';
export const runtime = 'nodejs';

const formatMs = (ms: number) => `${Math.round(ms)}ms`;

export async function POST(request: Request) {
	const requestStartedAt = Date.now();
	try {
		const body = validateRenderPayload(await request.json());
		const issues = validateProject({
			tracks: body.tracks,
			items: body.items,
			assets: body.assets,
			fps: body.fps,
			compositionWidth: body.compositionWidth,
			compositionHeight: body.compositionHeight,
			deletedAssets: [],
			shots: body.shots ?? [],
			advanced: body.advanced,
			propertyGraph: body.propertyGraph,
		});
		if (issues.some((issue) => issue.severity === 'error')) {
			throw new Error('Project validation errors block rendering.');
		}
		if (
			body.preflightHash &&
			issues.some((issue) => issue.severity === 'warning') &&
			body.warningsConfirmed !== true
		) {
			throw new Error('Project warnings require explicit confirmation.');
		}

		const requestedCodec = (body as {codec?: unknown}).codec;

		if (requestedCodec !== undefined && requestedCodec !== 'h264') {
			throw new Error('codec must be "h264"');
		}

		const fullDuration = getCompositionDuration(Object.values(body.items));
		const renderedFrames = body.frameRange
			? body.frameRange[1] - body.frameRange[0] + 1
			: fullDuration;
		const durationInSeconds = renderedFrames / body.fps;
		const backend = renderBackend();

		// eslint-disable-next-line no-console
		console.log(
			`[Render Start] backend=${backend}` +
				` | size=${body.compositionWidth}x${body.compositionHeight}` +
				` | fps=${body.fps}` +
				` | assets=${Object.keys(body.assets).length}` +
				` | items=${Object.keys(body.items).length}` +
				` | tracks=${body.tracks.length}` +
				` | approxDuration=${durationInSeconds.toFixed(2)}s`,
		);

		const {bucketName, renderId, backend: submittedBackend} = await submitRender(body);

		// eslint-disable-next-line no-console
		console.log(
			`[Render ${backend === 'local' ? 'Local' : 'Lambda'} Initiated] renderId=${renderId}` +
				` | bucket=${bucketName}` +
				` | initMs=${formatMs(Date.now() - requestStartedAt)}`,
		);

		const response: RenderVideoResponse = {
			type: 'success',
			bucketName,
			renderId,
			backend: submittedBackend,
		};

		return Response.json(response);
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error('Render API error:', e);
		const response: RenderVideoResponse = {
			type: 'error',
			error: e instanceof Error ? e.message : 'Render service unavailable',
		};

		return Response.json(response, {status: 400});
	}
}
