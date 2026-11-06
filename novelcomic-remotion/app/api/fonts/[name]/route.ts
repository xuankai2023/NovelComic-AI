import {GOOGLE_FONTS_DATABASE} from '../../../../src/editor/data/google-fonts';

export const runtime = 'nodejs';

export async function GET(
	_request: Request,
	context: {params: Promise<{name: string}>},
) {
	const {name} = await context.params;
	const entry = GOOGLE_FONTS_DATABASE.find((font) => font.fontFamily === name);

	if (!entry) {
		return new Response('Font not found', {
			status: 404,
		});
	}

	return new Response(JSON.stringify(entry), {
		status: 200,
		headers: {'Content-Type': 'application/json'},
	});
}
