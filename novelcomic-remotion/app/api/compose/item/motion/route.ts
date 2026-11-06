import {z} from 'zod';
import {applyMotion} from '../../../../../src/editor/comic/apply-motion';
import {applySpriteMotion} from '../../../../../src/editor/comic/apply-sprite-motion';
import {MOUTH_SHAPES} from '../../../../../src/editor/comic/build-sprite-motion';
import {MAX_KEYFRAMES_PER_ITEM} from '../../../../../src/editor/comic/limits';
import {applyCommand} from '../../../../../src/editor/compose/apply-command';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	cameraKeyframeSchema,
	cameraPresetIdSchema,
	draftEnvelopeSchema,
	itemPresetIdSchema,
	projectBaseSchema,
	transformKeyframeSchema,
} from '../../../../../src/editor/compose/schemas';
import {MOTION_INTENSITIES} from '../../../../../src/editor/motion/intensity';

export const runtime = 'nodejs';

const spriteMotionSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('blink'),
		openAssetId: z.string().min(1),
		closedAssetId: z.string().min(1),
		seed: z.number().int(),
	}),
	z.object({
		kind: z.literal('mouth-flap'),
		closedAssetId: z.string().min(1),
		halfAssetId: z.string().min(1).optional(),
		openAssetId: z.string().min(1),
		dialogueItemIds: z.array(z.string().min(1)).optional(),
		phonemeCues: z
			.array(
				z.object({
					from: z.number().int().nonnegative(),
					durationInFrames: z.number().int().positive(),
					mouthShape: z.enum(MOUTH_SHAPES).optional(),
					phoneme: z.string().min(1).optional(),
				}),
			)
			.max(MAX_KEYFRAMES_PER_ITEM)
			.optional(),
	}),
]);

const itemMotionRequestSchema = draftEnvelopeSchema
	.extend({
		project: projectBaseSchema,
		target: z.discriminatedUnion('type', [
			z.object({
				type: z.literal('item'),
				itemId: z.string().min(1),
				presetId: itemPresetIdSchema.optional(),
			}),
			z.object({
				type: z.literal('shot'),
				shotId: z.string().min(1),
				presetId: cameraPresetIdSchema.optional(),
			}),
		]),
		mode: z.enum(['replace', 'append']),
		sprite: spriteMotionSchema.optional(),
		parameters: z
			.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
			.refine(
				(value) =>
					value.intensity === undefined ||
					(typeof value.intensity === 'string' &&
						MOTION_INTENSITIES.includes(
							value.intensity as (typeof MOTION_INTENSITIES)[number],
						)),
				'intensity must be light, medium, or heavy',
			)
			.optional(),
		seed: z.number().int().optional(),
		keyframes: z
			.array(transformKeyframeSchema)
			.max(MAX_KEYFRAMES_PER_ITEM)
			.optional(),
		cameraKeyframes: z
			.array(cameraKeyframeSchema)
			.max(MAX_KEYFRAMES_PER_ITEM)
			.optional(),
	})
	.superRefine((input, context) => {
		if (!input.sprite) {
			return;
		}

		if (
			input.sprite.kind === 'mouth-flap' &&
			(input.sprite.dialogueItemIds?.length ?? 0) === 0 &&
			(input.sprite.phonemeCues?.length ?? 0) === 0
		) {
			context.addIssue({
				code: 'custom',
				message: 'Mouth flap requires dialogueItemIds or phonemeCues',
				path: ['sprite', 'dialogueItemIds'],
			});
		}

		if (input.target.type !== 'item') {
			context.addIssue({
				code: 'custom',
				message: 'Sprite motion only applies to image items',
				path: ['target'],
			});
		}

		if (
			input.target.presetId ||
			input.keyframes ||
			input.cameraKeyframes ||
			input.parameters ||
			input.seed !== undefined
		) {
			context.addIssue({
				code: 'custom',
				message: 'Sprite motion cannot include transform or camera fields',
				path: ['sprite'],
			});
		}
	});

export async function POST(request: Request) {
	return runComposeRoute(request, (body) => {
		const input = itemMotionRequestSchema.parse(body);
		const result = applyCommand({
			project: input.project,
			command: (project) => {
				if (input.sprite && input.target.type === 'item') {
					return applySpriteMotion(project, {
						itemId: input.target.itemId,
						mode: input.mode,
						sprite: input.sprite,
					});
				}

				return applyMotion(project, {
					target: input.target,
					mode: input.mode,
					parameters: input.parameters,
					seed: input.seed,
					keyframes: input.keyframes,
					cameraKeyframes: input.cameraKeyframes,
				});
			},
		});

		if (!result.ok) {
			throw result.error;
		}

		return {project: result.value};
	});
}
