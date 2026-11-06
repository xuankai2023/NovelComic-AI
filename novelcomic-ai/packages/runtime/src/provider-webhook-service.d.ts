import type { AiTaskDocument, AiTaskError, JsonValue } from '@novelcomic/contracts';
import { type CoreProviderResult } from '@novelcomic/core';
export type ProviderWebhookHeaders = Record<string, string | undefined>;
export interface ProviderWebhookHandleResult {
    status: 'accepted';
    provider: string;
    provider_status?: string;
}
export interface ProviderWebhookTaskRepository {
    requireByAiTaskId(aiTaskId: string): Promise<AiTaskDocument>;
    findByProviderRequestId?(providerRequestId: string): Promise<AiTaskDocument | null>;
    markProviderFailedAttempt?(input: ProviderWebhookFailedAttemptUpdate): Promise<AiTaskDocument>;
    applyProviderResult(aiTaskId: string, result: CoreProviderResult): Promise<AiTaskDocument>;
}
export interface ProviderWebhookFailedAttemptUpdate {
    ai_task_id: string;
    provider?: string;
    provider_model_id?: string;
    provider_request_id?: string;
    provider_status?: string;
    attempt: number;
    error: AiTaskError;
    skip_provider?: string;
    has_fallback: boolean;
}
export interface ProviderWebhookEventRepository {
    insert(input: ProviderWebhookEventRecord): Promise<{
        inserted: boolean;
    }>;
}
export interface ProviderWebhookEventRecord {
    ai_task_id: string;
    provider: string;
    provider_request_id?: string;
    event_id: string;
    event_type: string;
    provider_status?: string;
    normalized_status: CoreProviderResult['status'];
    raw_summary: JsonValue;
    signature_verified: boolean;
    received_at: Date;
}
export interface ProviderWebhookQueue {
    add(name: string, data: {
        ai_task_id: string;
        enqueued_at: number;
        skip_providers?: string[];
    }, options?: {
        jobId?: string;
    }): Promise<unknown>;
}
export interface ProviderWebhookLogger {
    info(fields: Record<string, unknown>, message: string): void;
}
export interface ProviderWebhookServiceOptions {
    taskRepository?: ProviderWebhookTaskRepository;
    providerEventRepository?: ProviderWebhookEventRepository;
    providerExecutionQueue?: ProviderWebhookQueue;
    artifactProcessingQueue?: ProviderWebhookQueue;
    logger?: ProviderWebhookLogger;
}
export interface ProviderWebhookHandler {
    handleWebhook(provider: string, body: unknown, headers: ProviderWebhookHeaders): Promise<ProviderWebhookHandleResult>;
}
export declare class ProviderWebhookService implements ProviderWebhookHandler {
    private readonly options;
    constructor(options?: ProviderWebhookServiceOptions);
    handleWebhook(provider: string, body: unknown, headers: ProviderWebhookHeaders): Promise<ProviderWebhookHandleResult>;
    private resolveTask;
    private recordEvent;
    private applyResolvedProviderResult;
    private handleFailedResult;
}
export declare class ProviderWebhookTaskNotFoundError extends Error {
    readonly aiTaskId: string | undefined;
    readonly providerRequestId: string | undefined;
    readonly code = "PROVIDER_WEBHOOK_TASK_NOT_FOUND";
    constructor(aiTaskId: string | undefined, providerRequestId: string | undefined);
}
export declare function coerceJsonWebhookBody(body: unknown): unknown;
