import {z} from 'zod';
import {importPsdLayerManifest} from '../../../../../src/editor/advanced/psd-import';
import {importLayers} from '../../../../../src/editor/comic/import-layers';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
	psdManifestSchema,
	remoteUrlSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const requestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	projectId: z.string().min(1),
	shotId: z.string().min(1),
	sourceUrl: remoteUrlSchema,
	manifest: psdManifestSchema,
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = requestSchema.parse(body);
		const layerPackage = importPsdLayerManifest({
			manifest: input.manifest,
			projectId: input.projectId,
			shotId: input.shotId,
			sourceUrl: input.sourceUrl,
		});
		const result = applyCommand({
			project: input.project,
			command: (project) => importLayers(project, layerPackage),
		});
		if (!result.ok) {
			throw result.error;
		}
		return {project: result.value, layerPackage};
	});
}
