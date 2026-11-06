import {importLayers} from '../../../../../src/editor/comic/import-layers';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	layerPackageSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const layersImportRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	layerPackage: layerPackageSchema,
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = layersImportRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return importLayers(project, input.layerPackage);
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
