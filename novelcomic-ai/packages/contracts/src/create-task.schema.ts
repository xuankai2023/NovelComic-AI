import { z } from 'zod';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const CreateAiTaskOptionsSchema = z.record(z.string(), JsonValueSchema);
export const ClientContextSchema = z.record(z.string(), JsonValueSchema);
export const LocaleSchema = z.enum(['zh', 'en']);

export const CreateAiTaskRequestSchema = z
  .object({
    model_id: z.string().trim().min(1),
    options: CreateAiTaskOptionsSchema,
    webhook_url: z.string().url(),
    trace_id: z.string().trim().min(1).optional(),
    idempotency_key: z.string().trim().min(1).optional(),
    locale: LocaleSchema.optional(),
    client_context: ClientContextSchema.optional(),
  })
  .strict();

export const CreateAiTaskResponseSchema = z
  .object({
    ai_task_id: z.string().min(1),
    status: z.enum(['queued', 'existing']),
  })
  .strict();

export type CreateAiTaskOptions = z.infer<typeof CreateAiTaskOptionsSchema>;
export type ClientContext = z.infer<typeof ClientContextSchema>;
export type Locale = z.infer<typeof LocaleSchema>;
export type CreateAiTaskRequest = z.infer<typeof CreateAiTaskRequestSchema>;
export type CreateAiTaskResponse = z.infer<typeof CreateAiTaskResponseSchema>;
