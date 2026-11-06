import { z } from 'zod';

import { JsonValueSchema } from './create-task.schema.js';

export const ProviderResultStatusSchema = z.enum([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'waiting_provider',
]);

export const NormalizedTaskArtifactSchema = z
  .object({
    type: z.enum(['image', 'video', 'audio', 'file']),
    url: z.string().min(1),
    mime_type: z.string().min(1).optional(),
    file_size: z.number().int().nonnegative().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    duration_seconds: z.number().nonnegative().optional(),
    aspect_ratio: z.string().min(1).optional(),
  })
  .strict();

export const NormalizedTaskResultSchema = z
  .object({
    output: z.string().optional(),
    data: JsonValueSchema.optional(),
    artifacts: z.array(NormalizedTaskArtifactSchema).optional(),
    metadata: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export const NormalizedErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    provider_status: z.string().min(1).optional(),
    raw_summary: JsonValueSchema.optional(),
    error_code: z.number().int().optional(),
    error_params: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export const ProviderUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
    currency: z.string().min(1).optional(),
  })
  .strict();

export const ProviderResultSchema = z
  .object({
    ai_task_id: z.string().min(1),
    status: ProviderResultStatusSchema,
    provider: z.string().min(1),
    model_id: z.string().min(1),
    provider_model_id: z.string().min(1).optional(),
    provider_request_id: z.string().min(1).optional(),
    provider_status: z.string().min(1).optional(),
    result: NormalizedTaskResultSchema.optional(),
    usage: ProviderUsageSchema.optional(),
    error: NormalizedErrorSchema.optional(),
    raw_summary: JsonValueSchema.optional(),
  })
  .strict();

export const ParsedProviderResultSchema = ProviderResultSchema.omit({
  ai_task_id: true,
  model_id: true,
});

export type ProviderResultStatus = z.infer<typeof ProviderResultStatusSchema>;
export type NormalizedTaskArtifact = z.infer<typeof NormalizedTaskArtifactSchema>;
export type NormalizedTaskResult = z.infer<typeof NormalizedTaskResultSchema>;
export type NormalizedError = z.infer<typeof NormalizedErrorSchema>;
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;
export type ParsedProviderResult = z.infer<typeof ParsedProviderResultSchema>;
export type ProviderResult = z.infer<typeof ProviderResultSchema>;
