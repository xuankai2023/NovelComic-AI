import {inspectComposeCapabilities} from '../../../../src/editor/rendering/compose-capabilities';

export const runtime = 'nodejs';

export async function GET(request: Request) {
	const url = new URL(request.url);
	const fonts = (url.searchParams.get('fonts') ?? '')
		.split(',')
		.map((font) => font.trim())
		.filter(Boolean);
	return Response.json(await inspectComposeCapabilities({fonts}));
}
