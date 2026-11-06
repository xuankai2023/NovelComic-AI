import { z } from 'zod';
export declare const IsoDateTimeStringSchema: z.ZodString;
export declare const AiTaskWebhookStatusSchema: z.ZodEnum<{
    succeeded: "succeeded";
    failed: "failed";
    timed_out: "timed_out";
    cancelled: "cancelled";
}>;
export declare const AiTaskPublicWebhookStatusSchema: z.ZodEnum<{
    success: "success";
    failed: "failed";
    timed_out: "timed_out";
    cancelled: "cancelled";
}>;
export declare const AiTaskWebhookErrorSchema: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    retryable: z.ZodOptional<z.ZodBoolean>;
    details: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
}, z.core.$strict>;
export declare const AiTaskUsageSchema: z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
export declare const AiTaskWebhookPayloadSchema: z.ZodObject<{
    ai_task_id: z.ZodString;
    status: z.ZodEnum<{
        succeeded: "succeeded";
        failed: "failed";
        timed_out: "timed_out";
        cancelled: "cancelled";
    }>;
    model_id: z.ZodString;
    trace_id: z.ZodOptional<z.ZodString>;
    provider: z.ZodOptional<z.ZodString>;
    provider_model_id: z.ZodOptional<z.ZodString>;
    provider_request_id: z.ZodOptional<z.ZodString>;
    client_context: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
    result: z.ZodOptional<z.ZodObject<{
        output: z.ZodOptional<z.ZodString>;
        data: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
        artifacts: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodEnum<{
                file: "file";
                image: "image";
                video: "video";
                audio: "audio";
            }>;
            url: z.ZodString;
            mime_type: z.ZodOptional<z.ZodString>;
            file_size: z.ZodOptional<z.ZodNumber>;
            width: z.ZodOptional<z.ZodNumber>;
            height: z.ZodOptional<z.ZodNumber>;
            duration_seconds: z.ZodOptional<z.ZodNumber>;
            aspect_ratio: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
    }, z.core.$strict>>;
    usage: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        retryable: z.ZodOptional<z.ZodBoolean>;
        details: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodString;
}, z.core.$strict>;
export declare const AiTaskPublicWebhookPayloadSchema: z.ZodObject<{
    ai_task_id: z.ZodString;
    status: z.ZodEnum<{
        success: "success";
        failed: "failed";
        timed_out: "timed_out";
        cancelled: "cancelled";
    }>;
    model_id: z.ZodString;
    trace_id: z.ZodOptional<z.ZodString>;
    provider: z.ZodOptional<z.ZodString>;
    provider_model_id: z.ZodOptional<z.ZodString>;
    provider_request_id: z.ZodOptional<z.ZodString>;
    client_context: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
    result: z.ZodOptional<z.ZodObject<{
        output: z.ZodOptional<z.ZodString>;
        data: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
        artifacts: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodEnum<{
                file: "file";
                image: "image";
                video: "video";
                audio: "audio";
            }>;
            url: z.ZodString;
            mime_type: z.ZodOptional<z.ZodString>;
            file_size: z.ZodOptional<z.ZodNumber>;
            width: z.ZodOptional<z.ZodNumber>;
            height: z.ZodOptional<z.ZodNumber>;
            duration_seconds: z.ZodOptional<z.ZodNumber>;
            aspect_ratio: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
    }, z.core.$strict>>;
    usage: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
    error: z.ZodNullable<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        retryable: z.ZodOptional<z.ZodBoolean>;
        details: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
    }, z.core.$strict>>;
    started_at: z.ZodString;
    completed_at: z.ZodString;
}, z.core.$strict>;
export type AiTaskWebhookStatus = z.infer<typeof AiTaskWebhookStatusSchema>;
export type AiTaskPublicWebhookStatus = z.infer<typeof AiTaskPublicWebhookStatusSchema>;
export type AiTaskWebhookError = z.infer<typeof AiTaskWebhookErrorSchema>;
export type AiTaskUsage = z.infer<typeof AiTaskUsageSchema>;
export type AiTaskWebhookPayload = z.infer<typeof AiTaskWebhookPayloadSchema>;
export type AiTaskPublicWebhookPayload = z.infer<typeof AiTaskPublicWebhookPayloadSchema>;
