import { z } from 'zod';

export const AI_TASK_STATUSES = [
  'received',
  'queued',
  'submitted_to_provider',
  'waiting_provider',
  'processing_artifacts',
  'callback_pending',
  'callback_failed',
  'callback_succeeded',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'ignored',
] as const;

export const AiTaskStatusSchema = z.enum(AI_TASK_STATUSES);
export type AiTaskStatus = z.infer<typeof AiTaskStatusSchema>;

export const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'timed_out', 'cancelled'] as const;

export const TerminalAiTaskStatusSchema = z.enum(TERMINAL_TASK_STATUSES);
export type TerminalAiTaskStatus = z.infer<typeof TerminalAiTaskStatusSchema>;

export const TASK_STATUS_ORDER: Record<AiTaskStatus, number> = {
  received: 0,
  queued: 1,
  submitted_to_provider: 2,
  waiting_provider: 3,
  processing_artifacts: 4,
  callback_pending: 5,
  callback_failed: 6,
  callback_succeeded: 7,
  succeeded: 8,
  failed: 8,
  timed_out: 8,
  cancelled: 8,
  ignored: 8,
};

export function isTerminalTaskStatus(status: AiTaskStatus): status is TerminalAiTaskStatus {
  return TerminalAiTaskStatusSchema.safeParse(status).success;
}
