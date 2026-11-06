import {z} from 'zod';
import {buildPsdLayerPackage} from '../../../../../src/editor/advanced/psd-export';
import {errorToResponse} from '../../../../../src/editor/compose/http-response';
import {layerPackageSchema} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const requestSchema = z.object({
	layerPackage: layerPackageSchema,
});

export async function POST(request: Request) {
	try {
		const input = requestSchema.parse(await request.json());
		const result = await buildPsdLayerPackage(input.layerPackage);
		const response = new Response(new Uint8Array(result.body), {
			headers: {
				'Content-Type': 'application/zip',
				'Content-Disposition': `attachment; filename="${result.filename}"`,
				'X-NovelComic-Format': 'psd-layer-manifest',
				'X-NovelComic-Warnings': result.warnings.join(' | '),
			},
		});
		return response;
	} catch (error) {
		return errorToResponse(error);
	}
}
