import {z} from 'zod';
import {appendImageSequence} from '../../../../../src/editor/comic/append-image-sequence';
import {MAX_SHOTS} from '../../../../../src/editor/comic/limits';
import {
	BLURRED_BACKGROUND_CONTAIN,
	CONTAIN_BLUR_VERSION,
	PANEL_BLUR_RADIUS_PX,
	PANEL_DIM_OPACITY,
} from '../../../../../src/editor/comic/panel-fit';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	cameraPresetIdSchema,
	draftEnvelopeSchema,
	projectBaseSchema,
	remoteUrlSchema,
} from '../../../../../src/editor/compose/schemas';
import {resolveAllowedHosts} from '../../../../../src/editor/compose/validate-remote-url';

export const runtime = 'nodejs';

const imageSequenceRequestSchema = draftEnvelopeSchema
	.extend({
		project: projectBaseSchema,
		images: z
			.array(
				z.object({
					shotId: z.string().min(1),
					url: remoteUrlSchema,
					width: z.number().int().positive(),
					height: z.number().int().positive(),
					durationInFrames: z.number().int().positive(),
					cameraPresetId: cameraPresetIdSchema.optional(),
					seed: z.number().int().optional(),
				}),
			)
			.min(1)
			.max(MAX_SHOTS),
		panelFitPolicy: z.literal(BLURRED_BACKGROUND_CONTAIN).optional(),
		fitAlgorithmVersion: z.literal(CONTAIN_BLUR_VERSION).optional(),
		blurRadiusPx: z.number().optional(),
		dimOpacity: z.number().optional(),
		compositionWidth: z.number().int().positive().optional(),
		compositionHeight: z.number().int().positive().optional(),
	})
	.superRefine((value, ctx) => {
		if (!value.panelFitPolicy) {
			return;
		}

		if (value.fitAlgorithmVersion !== CONTAIN_BLUR_VERSION) {
			ctx.addIssue({
				code: 'custom',
				path: ['fitAlgorithmVersion'],
				message: 'fitAlgorithmVersion must be contain-blur-v1',
			});
		}

		if (value.blurRadiusPx !== PANEL_BLUR_RADIUS_PX) {
			ctx.addIssue({
				code: 'custom',
				path: ['blurRadiusPx'],
				message: 'blurRadiusPx must be 28',
			});
		}

		if (value.dimOpacity !== PANEL_DIM_OPACITY) {
			ctx.addIssue({
				code: 'custom',
				path: ['dimOpacity'],
				message: 'dimOpacity must be 0.45',
			});
		}
	})
	.superRefine((value, ctx) => {
		const hasWidth = value.compositionWidth !== undefined;
		const hasHeight = value.compositionHeight !== undefined;
		if (hasWidth === hasHeight) {
			return;
		}

		ctx.addIssue({
			code: 'custom',
			path: ['compositionWidth'],
			message: 'compositionWidth and compositionHeight must be set together',
		});
	});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = imageSequenceRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				return appendImageSequence(project, {
					images: input.images,
					allowedHosts: resolveAllowedHosts(),
					panelFitPolicy: input.panelFitPolicy,
					blurRadiusPx: input.blurRadiusPx,
					dimOpacity: input.dimOpacity,
					compositionWidth: input.compositionWidth,
					compositionHeight: input.compositionHeight,
				});
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
