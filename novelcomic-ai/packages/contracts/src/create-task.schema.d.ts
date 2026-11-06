import { z } from 'zod';
export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export declare const JsonValueSchema: z.ZodType<JsonValue>;
export declare const CreateAiTaskOptionsSchema: z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
export declare const ClientContextSchema: z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
export declare const LocaleSchema: z.ZodEnum<{
    zh: "zh";
    en: "en";
}>;
export declare const CreateAiTaskRequestSchema: z.ZodObject<{
    model_id: z.ZodString;
    options: z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>;
    webhook_url: z.ZodString;
    trace_id: z.ZodOptional<z.ZodString>;
    idempotency_key: z.ZodOptional<z.ZodString>;
    locale: z.ZodOptional<z.ZodEnum<{
        zh: "zh";
        en: "en";
    }>>;
    client_context: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JsonValue, unknown, z.core.$ZodTypeInternals<JsonValue, unknown>>>>;
}, z.core.$strict>;
export declare const CreateAiTaskResponseSchema: z.ZodObject<{
    ai_task_id: z.ZodString;
    status: z.ZodEnum<{
        queued: "queued";
        existing: "existing";
    }>;
}, z.core.$strict>;
export type CreateAiTaskOptions = z.infer<typeof CreateAiTaskOptionsSchema>;
export type ClientContext = z.infer<typeof ClientContextSchema>;
export type Locale = z.infer<typeof LocaleSchema>;
export type CreateAiTaskRequest = z.infer<typeof CreateAiTaskRequestSchema>;
export type CreateAiTaskResponse = z.infer<typeof CreateAiTaskResponseSchema>;
