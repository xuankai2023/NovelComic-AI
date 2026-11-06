import {
	probeVideo,
	VideoProbeResult,
} from '../../../../src/editor/compose/probe-video';

export const runtime = 'nodejs';

type ProbeResponse =
	| ({ type: 'success' } & VideoProbeResult)
	| { type: 'error'; error: string };

export async function POST(request: Request) {
	try {
		const body = await request.json();

		if (!body.url || typeof body.url !== 'string') {
			throw new Error('url is required');
		}

		const result = await probeVideo(body.url);

		const response: ProbeResponse = { type: 'success', ...result };
		return Response.json(response);
	} catch (e) {
		// console.error('Probe error:', e);
		const response: ProbeResponse = {
			type: 'error',
			error: e instanceof Error ? e.message : 'Probe failed',
		};
		return Response.json(response, { status: 400 });
	}
}
