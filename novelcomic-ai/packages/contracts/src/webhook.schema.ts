import { z } from 'zod';

import { ClientContextSchema, JsonValueSchema } from './create-task.schema.js';
import { NormalizedTaskResultSchema } from './provider-result.schema.js';

export const IsoDateTimeStringSchema = z.string().datetime();

export const AiTaskWebhookStatusSchema = z.enum(['succeeded', 'failed', 'timed_out', 'cancelled']);
export const AiTaskPublicWebhookStatusSchema = z.enum(['success', 'failed', 'timed_out', 'cancelled']);

export const AiTaskWebhookErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
    details: JsonValueSchema.optional(),
  })
  .strict();

export const AiTaskUsageSchema = z.record(z.string(), JsonValueSchema);

export const AiTaskWebhookPayloadSchema = z
  .object({
    ai_task_id: z.string().min(1),
    status: AiTaskWebhookStatusSchema,
    model_id: z.string().min(1),
    trace_id: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    provider_model_id: z.string().min(1).optional(),
    provider_request_id: z.string().min(1).optional(),
    client_context: ClientContextSchema.optional(),
    result: NormalizedTaskResultSchema.optional(),
    usage: AiTaskUsageSchema.optional(),
    error: AiTaskWebhookErrorSchema.optional(),
    started_at: IsoDateTimeStringSchema,
    completed_at: IsoDateTimeStringSchema,
  })
  .strict();

export const AiTaskPublicWebhookPayloadSchema = z
  .object({
    ai_task_id: z.string().min(1),
    status: AiTaskPublicWebhookStatusSchema,
    model_id: z.string().min(1),
    trace_id: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    provider_model_id: z.string().min(1).optional(),
    provider_request_id: z.string().min(1).optional(),
    client_context: ClientContextSchema.optional(),
    result: NormalizedTaskResultSchema.optional(),
    usage: AiTaskUsageSchema.optional(),
    error: AiTaskWebhookErrorSchema.nullable(),
    started_at: IsoDateTimeStringSchema,
    completed_at: IsoDateTimeStringSchema,
  })
  .strict();

export type AiTaskWebhookStatus = z.infer<typeof AiTaskWebhookStatusSchema>;
export type AiTaskPublicWebhookStatus = z.infer<typeof AiTaskPublicWebhookStatusSchema>;
export type AiTaskWebhookError = z.infer<typeof AiTaskWebhookErrorSchema>;
export type AiTaskUsage = z.infer<typeof AiTaskUsageSchema>;
export type AiTaskWebhookPayload = z.infer<typeof AiTaskWebhookPayloadSchema>;
export type AiTaskPublicWebhookPayload = z.infer<typeof AiTaskPublicWebhookPayloadSchema>;
