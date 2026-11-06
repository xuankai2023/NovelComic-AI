import { z } from 'zod';

export * from './create-task.schema.js';
export * from './db.schema.js';
export * from './provider-result.schema.js';
export * from './task-state.js';
export * from './webhook.schema.js';

export const smokeJobInputSchema = z.object({ message: z.string().trim().min(1).max(500).default('smoke') });
export type SmokeJobInput = z.infer<typeof smokeJobInputSchema>;
export const smokeJobResultSchema = z.object({ ok: z.literal(true), message: z.string(), processedAt: z.string().datetime() });
export type SmokeJobResult = z.infer<typeof smokeJobResultSchema>;
