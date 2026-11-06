import { z } from 'zod';
export declare const AiTaskCallbackStateSchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodEnum<{
        succeeded: "succeeded";
        failed: "failed";
        pending: "pending";
    }>>;
    attempt: z.ZodOptional<z.ZodNumber>;
    last_error: z.ZodOptional<z.ZodString>;
    last_attempt_at: z.ZodOptional<z.ZodDate>;
    next_retry_at: z.ZodOptional<z.ZodDate>;
}, z.core.$strict>;
export declare const AiTaskErrorSchema: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    retryable: z.ZodOptional<z.ZodBoolean>;
    details: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
}, z.core.$strict>;
export declare const ProviderTelemetryAttemptSchema: z.ZodObject<{
    provider: z.ZodOptional<z.ZodString>;
    provider_model_id: z.ZodOptional<z.ZodString>;
    provider_request_id: z.ZodOptional<z.ZodString>;
    phase: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
    error_code: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    error_message: z.ZodOptional<z.ZodString>;
    submit_duration_ms: z.ZodOptional<z.ZodNumber>;
    provider_duration_ms: z.ZodOptional<z.ZodNumber>;
    total_duration_ms: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const ProviderTelemetrySchema: z.ZodObject<{
    provider: z.ZodOptional<z.ZodString>;
    provider_model_id: z.ZodOptional<z.ZodString>;
    provider_request_id: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
    attempts: z.ZodOptional<z.ZodArray<z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
        provider_model_id: z.ZodOptional<z.ZodString>;
        provider_request_id: z.ZodOptional<z.ZodString>;
        phase: z.ZodOptional<z.ZodString>;
        status: z.ZodOptional<z.ZodString>;
        error_code: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
        error_message: z.ZodOptional<z.ZodString>;
        submit_duration_ms: z.ZodOptional<z.ZodNumber>;
        provider_duration_ms: z.ZodOptional<z.ZodNumber>;
        total_duration_ms: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
    queue_wait_ms: z.ZodOptional<z.ZodNumber>;
    submit_duration_ms: z.ZodOptional<z.ZodNumber>;
    provider_duration_ms: z.ZodOptional<z.ZodNumber>;
    artifact_process_ms: z.ZodOptional<z.ZodNumber>;
    total_gateway_ms: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const AiTaskDocumentSchema: z.ZodObject<{
    ai_task_id: z.ZodString;
    status: z.ZodEnum<{
        queued: "queued";
        received: "received";
        submitted_to_provider: "submitted_to_provider";
        waiting_provider: "waiting_provider";
        processing_artifacts: "processing_artifacts";
        callback_pending: "callback_pending";
        callback_failed: "callback_failed";
        callback_succeeded: "callback_succeeded";
        succeeded: "succeeded";
        failed: "failed";
        timed_out: "timed_out";
        cancelled: "cancelled";
        ignored: "ignored";
    }>;
    model_id: z.ZodString;
    core_model_id: z.ZodString;
    options: z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
    webhook_url: z.ZodString;
    trace_id: z.ZodOptional<z.ZodString>;
    idempotency_key: z.ZodOptional<z.ZodString>;
    locale: z.ZodOptional<z.ZodEnum<{
        zh: "zh";
        en: "en";
    }>>;
    client_context: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
    created_at: z.ZodDate;
    updated_at: z.ZodDate;
    provider: z.ZodOptional<z.ZodString>;
    provider_model_id: z.ZodOptional<z.ZodString>;
    provider_request_id: z.ZodOptional<z.ZodString>;
    provider_status: z.ZodOptional<z.ZodString>;
    result_mode: z.ZodOptional<z.ZodEnum<{
        sync: "sync";
        polling: "polling";
        webhook: "webhook";
    }>>;
    attempt: z.ZodOptional<z.ZodNumber>;
    attempts: z.ZodOptional<z.ZodNumber>;
    skip_providers: z.ZodOptional<z.ZodArray<z.ZodString>>;
    provider_telemetry: z.ZodOptional<z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
        provider_model_id: z.ZodOptional<z.ZodString>;
        provider_request_id: z.ZodOptional<z.ZodString>;
        status: z.ZodOptional<z.ZodString>;
        attempts: z.ZodOptional<z.ZodArray<z.ZodObject<{
            provider: z.ZodOptional<z.ZodString>;
            provider_model_id: z.ZodOptional<z.ZodString>;
            provider_request_id: z.ZodOptional<z.ZodString>;
            phase: z.ZodOptional<z.ZodString>;
            status: z.ZodOptional<z.ZodString>;
            error_code: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
            error_message: z.ZodOptional<z.ZodString>;
            submit_duration_ms: z.ZodOptional<z.ZodNumber>;
            provider_duration_ms: z.ZodOptional<z.ZodNumber>;
            total_duration_ms: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
        queue_wait_ms: z.ZodOptional<z.ZodNumber>;
        submit_duration_ms: z.ZodOptional<z.ZodNumber>;
        provider_duration_ms: z.ZodOptional<z.ZodNumber>;
        artifact_process_ms: z.ZodOptional<z.ZodNumber>;
        total_gateway_ms: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    result: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        retryable: z.ZodOptional<z.ZodBoolean>;
        details: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
    }, z.core.$strict>>;
    callback: z.ZodOptional<z.ZodObject<{
        status: z.ZodOptional<z.ZodEnum<{
            succeeded: "succeeded";
            failed: "failed";
            pending: "pending";
        }>>;
        attempt: z.ZodOptional<z.ZodNumber>;
        last_error: z.ZodOptional<z.ZodString>;
        last_attempt_at: z.ZodOptional<z.ZodDate>;
        next_retry_at: z.ZodOptional<z.ZodDate>;
    }, z.core.$strict>>;
    model_call_notify_status: z.ZodOptional<z.ZodEnum<{
        failed: "failed";
        sending: "sending";
        sent: "sent";
    }>>;
    model_call_notified_at: z.ZodOptional<z.ZodDate>;
    model_call_notify_error: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const AiCallbackDeliveryStatusSchema: z.ZodEnum<{
    succeeded: "succeeded";
    failed: "failed";
}>;
export declare const AiCallbackDeliveryDocumentSchema: z.ZodObject<{
    ai_task_id: z.ZodString;
    webhook_url: z.ZodString;
    attempt: z.ZodNumber;
    idempotency_key: z.ZodString;
    raw_body: z.ZodString;
    request_body_hash: z.ZodString;
    status: z.ZodEnum<{
        succeeded: "succeeded";
        failed: "failed";
    }>;
    response_status: z.ZodOptional<z.ZodNumber>;
    response_body_summary: z.ZodOptional<z.ZodString>;
    created_at: z.ZodDate;
    updated_at: z.ZodDate;
}, z.core.$strict>;
export type AiTaskCallbackState = z.infer<typeof AiTaskCallbackStateSchema>;
export type AiTaskError = z.infer<typeof AiTaskErrorSchema>;
export type ProviderTelemetry = z.infer<typeof ProviderTelemetrySchema>;
export type ProviderTelemetryAttempt = z.infer<typeof ProviderTelemetryAttemptSchema>;
export type AiTaskDocument = z.infer<typeof AiTaskDocumentSchema>;
export type AiCallbackDeliveryStatus = z.infer<typeof AiCallbackDeliveryStatusSchema>;
export type AiCallbackDeliveryDocument = z.infer<typeof AiCallbackDeliveryDocumentSchema>;
