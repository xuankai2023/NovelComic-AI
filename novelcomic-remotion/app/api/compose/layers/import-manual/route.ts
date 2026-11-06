import {z} from 'zod';
import {importManualLayers} from '../../../../../src/editor/comic/manual-layer-package';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	draftEnvelopeSchema,
	projectBaseSchema,
} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const manualLayersImportRequestSchema = draftEnvelopeSchema.extend({
	project: projectBaseSchema,
	shotId: z.string().min(1),
	applyDefaultMotion: z.boolean().optional(),
	animationSeed: z.number().int().optional(),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = manualLayersImportRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return importManualLayers(project, input.shotId, {
					applyDefaultMotion: input.applyDefaultMotion,
					animationSeed: input.animationSeed,
				});
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
