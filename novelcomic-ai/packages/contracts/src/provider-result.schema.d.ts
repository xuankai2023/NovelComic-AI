import { z } from 'zod';
export declare const ProviderResultStatusSchema: z.ZodEnum<{
    waiting_provider: "waiting_provider";
    succeeded: "succeeded";
    failed: "failed";
    timed_out: "timed_out";
    cancelled: "cancelled";
}>;
export declare const NormalizedTaskArtifactSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const NormalizedTaskResultSchema: z.ZodObject<{
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
}, z.core.$strict>;
export declare const NormalizedErrorSchema: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    retryable: z.ZodBoolean;
    provider_status: z.ZodOptional<z.ZodString>;
    raw_summary: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
    error_code: z.ZodOptional<z.ZodNumber>;
    error_params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
}, z.core.$strict>;
export declare const ProviderUsageSchema: z.ZodObject<{
    input_tokens: z.ZodOptional<z.ZodNumber>;
    output_tokens: z.ZodOptional<z.ZodNumber>;
    total_tokens: z.ZodOptional<z.ZodNumber>;
    cost: z.ZodOptional<z.ZodNumber>;
    currency: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const ProviderResultSchema: z.ZodObject<{
    ai_task_id: z.ZodString;
    status: z.ZodEnum<{
        waiting_provider: "waiting_provider";
        succeeded: "succeeded";
        failed: "failed";
        timed_out: "timed_out";
        cancelled: "cancelled";
    }>;
    provider: z.ZodString;
    model_id: z.ZodString;
    provider_model_id: z.ZodOptional<z.ZodString>;
    provider_request_id: z.ZodOptional<z.ZodString>;
    provider_status: z.ZodOptional<z.ZodString>;
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
    usage: z.ZodOptional<z.ZodObject<{
        input_tokens: z.ZodOptional<z.ZodNumber>;
        output_tokens: z.ZodOptional<z.ZodNumber>;
        total_tokens: z.ZodOptional<z.ZodNumber>;
        cost: z.ZodOptional<z.ZodNumber>;
        currency: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        retryable: z.ZodBoolean;
        provider_status: z.ZodOptional<z.ZodString>;
        raw_summary: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
        error_code: z.ZodOptional<z.ZodNumber>;
        error_params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
    }, z.core.$strict>>;
    raw_summary: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
}, z.core.$strict>;
export declare const ParsedProviderResultSchema: z.ZodObject<{
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
        retryable: z.ZodBoolean;
        provider_status: z.ZodOptional<z.ZodString>;
        raw_summary: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
        error_code: z.ZodOptional<z.ZodNumber>;
        error_params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>>;
    }, z.core.$strict>>;
    status: z.ZodEnum<{
        waiting_provider: "waiting_provider";
        succeeded: "succeeded";
        failed: "failed";
        timed_out: "timed_out";
        cancelled: "cancelled";
    }>;
    provider: z.ZodString;
    provider_model_id: z.ZodOptional<z.ZodString>;
    provider_request_id: z.ZodOptional<z.ZodString>;
    provider_status: z.ZodOptional<z.ZodString>;
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
    raw_summary: z.ZodOptional<z.ZodType<import("./create-task.schema.js").JsonValue, unknown, z.core.$ZodTypeInternals<import("./create-task.schema.js").JsonValue, unknown>>>;
    usage: z.ZodOptional<z.ZodObject<{
        input_tokens: z.ZodOptional<z.ZodNumber>;
        output_tokens: z.ZodOptional<z.ZodNumber>;
        total_tokens: z.ZodOptional<z.ZodNumber>;
        cost: z.ZodOptional<z.ZodNumber>;
        currency: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type ProviderResultStatus = z.infer<typeof ProviderResultStatusSchema>;
export type NormalizedTaskArtifact = z.infer<typeof NormalizedTaskArtifactSchema>;
export type NormalizedTaskResult = z.infer<typeof NormalizedTaskResultSchema>;
export type NormalizedError = z.infer<typeof NormalizedErrorSchema>;
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;
export type ParsedProviderResult = z.infer<typeof ParsedProviderResultSchema>;
export type ProviderResult = z.infer<typeof ProviderResultSchema>;
