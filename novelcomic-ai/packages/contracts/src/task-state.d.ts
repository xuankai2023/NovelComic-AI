import { z } from 'zod';
export declare const AI_TASK_STATUSES: readonly ["received", "queued", "submitted_to_provider", "waiting_provider", "processing_artifacts", "callback_pending", "callback_failed", "callback_succeeded", "succeeded", "failed", "timed_out", "cancelled", "ignored"];
export declare const AiTaskStatusSchema: z.ZodEnum<{
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
export type AiTaskStatus = z.infer<typeof AiTaskStatusSchema>;
export declare const TERMINAL_TASK_STATUSES: readonly ["succeeded", "failed", "timed_out", "cancelled"];
export declare const TerminalAiTaskStatusSchema: z.ZodEnum<{
    succeeded: "succeeded";
    failed: "failed";
    timed_out: "timed_out";
    cancelled: "cancelled";
}>;
export type TerminalAiTaskStatus = z.infer<typeof TerminalAiTaskStatusSchema>;
export declare const TASK_STATUS_ORDER: Record<AiTaskStatus, number>;
export declare function isTerminalTaskStatus(status: AiTaskStatus): status is TerminalAiTaskStatus;
