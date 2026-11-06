import { z } from 'zod';
export * from './create-task.schema.js';
export * from './db.schema.js';
export * from './provider-result.schema.js';
export * from './task-state.js';
export * from './webhook.schema.js';
export declare const smokeJobInputSchema: z.ZodObject<{
    message: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type SmokeJobInput = z.infer<typeof smokeJobInputSchema>;
export declare const smokeJobResultSchema: z.ZodObject<{
    ok: z.ZodLiteral<true>;
    message: z.ZodString;
    processedAt: z.ZodString;
}, z.core.$strip>;
export type SmokeJobResult = z.infer<typeof smokeJobResultSchema>;
