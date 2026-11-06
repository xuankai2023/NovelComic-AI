import { z } from 'zod';

import {
  ClientContextSchema,
  CreateAiTaskOptionsSchema,
  JsonValueSchema,
  LocaleSchema,
} from './create-task.schema.js';
import { AiTaskStatusSchema } from './task-state.js';

export const AiTaskCallbackStateSchema = z
  .object({
    status: z.enum(['pending', 'succeeded', 'failed']).optional(),
    attempt: z.number().int().nonnegative().optional(),
    last_error: z.string().optional(),
    last_attempt_at: z.date().optional(),
    next_retry_at: z.date().optional(),
  })
  .strict();

export const AiTaskErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
    details: JsonValueSchema.optional(),
  })
  .strict();

export const ProviderTelemetryAttemptSchema = z
  .object({
    provider: z.string().min(1).optional(),
    provider_model_id: z.string().min(1).optional(),
    provider_request_id: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    error_code: z.union([z.number().int(), z.string().min(1)]).optional(),
    error_message: z.string().min(1).optional(),
    submit_duration_ms: z.number().nonnegative().optional(),
    provider_duration_ms: z.number().nonnegative().optional(),
    total_duration_ms: z.number().nonnegative().optional(),
  })
  .strict();

export const ProviderTelemetrySchema = z
  .object({
    provider: z.string().min(1).optional(),
    provider_model_id: z.string().min(1).optional(),
    provider_request_id: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    attempts: z.array(ProviderTelemetryAttemptSchema).optional(),
    queue_wait_ms: z.number().nonnegative().optional(),
    submit_duration_ms: z.number().nonnegative().optional(),
    provider_duration_ms: z.number().nonnegative().optional(),
    artifact_process_ms: z.number().nonnegative().optional(),
    total_gateway_ms: z.number().nonnegative().optional(),
  })
  .strict();

export const AiTaskDocumentSchema = z
  .object({
    ai_task_id: z.string().min(1),
    status: AiTaskStatusSchema,
    model_id: z.string().min(1),
    core_model_id: z.string().min(1),
    options: CreateAiTaskOptionsSchema,
    webhook_url: z.string().url(),
    trace_id: z.string().min(1).optional(),
    idempotency_key: z.string().min(1).optional(),
    locale: LocaleSchema.optional(),
    client_context: ClientContextSchema.optional(),
    created_at: z.date(),
    updated_at: z.date(),

    provider: z.string().min(1).optional(),
    provider_model_id: z.string().min(1).optional(),
    provider_request_id: z.string().min(1).optional(),
    provider_status: z.string().min(1).optional(),
    result_mode: z.enum(['sync', 'polling', 'webhook']).optional(),
    attempt: z.number().int().nonnegative().optional(),
    attempts: z.number().int().nonnegative().optional(),
    skip_providers: z.array(z.string().min(1)).optional(),
    provider_telemetry: ProviderTelemetrySchema.optional(),
    result: JsonValueSchema.optional(),
    error: AiTaskErrorSchema.optional(),
    callback: AiTaskCallbackStateSchema.optional(),
    model_call_notify_status: z.enum(['sending', 'sent', 'failed']).optional(),
    model_call_notified_at: z.date().optional(),
    model_call_notify_error: z.string().optional(),
  })
  .strict();

export const AiCallbackDeliveryStatusSchema = z.enum(['succeeded', 'failed']);

export const AiCallbackDeliveryDocumentSchema = z
  .object({
    ai_task_id: z.string().min(1),
    webhook_url: z.string().url(),
    attempt: z.number().int().positive(),
    idempotency_key: z.string().min(1),
    raw_body: z.string(),
    request_body_hash: z.string().min(1),
    status: AiCallbackDeliveryStatusSchema,
    response_status: z.number().int().optional(),
    response_body_summary: z.string().optional(),
    created_at: z.date(),
    updated_at: z.date(),
  })
  .strict();

export type AiTaskCallbackState = z.infer<typeof AiTaskCallbackStateSchema>;
export type AiTaskError = z.infer<typeof AiTaskErrorSchema>;
export type ProviderTelemetry = z.infer<typeof ProviderTelemetrySchema>;
export type ProviderTelemetryAttempt = z.infer<typeof ProviderTelemetryAttemptSchema>;
export type AiTaskDocument = z.infer<typeof AiTaskDocumentSchema>;
export type AiCallbackDeliveryStatus = z.infer<typeof AiCallbackDeliveryStatusSchema>;
export type AiCallbackDeliveryDocument = z.infer<typeof AiCallbackDeliveryDocumentSchema>;
