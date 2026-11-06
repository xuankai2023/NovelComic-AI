import {z} from 'zod';
import {
	COMIC_DEFAULT_FPS,
	COMIC_DEFAULT_HEIGHT,
	COMIC_DEFAULT_WIDTH,
} from '../../../../../src/editor/comic/limits';
import {createComicProject} from '../../../../../src/editor/compose/build-state';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {draftEnvelopeSchema} from '../../../../../src/editor/compose/schemas';

export const runtime = 'nodejs';

const projectCreateRequestSchema = draftEnvelopeSchema.extend({
	compositionWidth: z.number().int().positive().default(COMIC_DEFAULT_WIDTH),
	compositionHeight: z.number().int().positive().default(COMIC_DEFAULT_HEIGHT),
	fps: z.number().int().positive().default(COMIC_DEFAULT_FPS),
});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = projectCreateRequestSchema.parse(body);
		return {
			project: createComicProject({
				compositionWidth: input.compositionWidth,
				compositionHeight: input.compositionHeight,
				fps: input.fps,
			}),
		};
	});
}
