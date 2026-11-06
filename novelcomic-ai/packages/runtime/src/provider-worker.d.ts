import type { AiTaskDocument, AiTaskError } from '@novelcomic/contracts';
import { type CoreProviderResult, type CoreProviderResultMode } from '@novelcomic/core';
import type { ProviderExecutionJob, TaskSubmitQueue } from './task-service.js';
export interface ProviderWorkerTaskRepository {
    requireByAiTaskId(aiTaskId: string): Promise<AiTaskDocument>;
    markProviderSubmitted(input: {
        ai_task_id: string;
        provider: string;
        provider_model_id: string;
        provider_request_id?: string;
        provider_status: string;
        result_mode: CoreProviderResultMode;
        attempt: number;
    }): Promise<AiTaskDocument>;
    markProviderFailedAttempt(input: {
        ai_task_id: string;
        provider?: string;
        provider_model_id?: string;
        provider_request_id?: string;
        provider_status?: string;
        attempt: number;
        error: AiTaskError;
        skip_provider?: string;
        has_fallback: boolean;
    }): Promise<AiTaskDocument>;
    applyProviderResult(aiTaskId: string, result: CoreProviderResult): Promise<AiTaskDocument>;
    updateProviderTelemetry?(aiTaskId: string, telemetry: ProviderWorkerTelemetryUpdate): Promise<void>;
}
export interface ProviderWorkerTelemetryUpdate {
    provider: string;
    provider_model_id: string;
    provider_request_id?: string;
    status: string;
    queue_wait_ms?: number;
    submit_duration_ms?: number;
}
export interface ProviderWorkerAttemptRepository {
    upsertAttempt(input: ProviderWorkerAttemptRecord): Promise<void>;
}
export interface ProviderWorkerAttemptRecord {
    ai_task_id: string;
    attempt: number;
    provider: string;
    provider_model_id: string;
    provider_request_id?: string;
    status: string;
    result_mode: CoreProviderResultMode;
    submit_payload_summary?: Record<string, unknown>;
    provider_response_summary?: unknown;
    started_at: Date;
    created_at: Date;
    updated_at: Date;
}
export interface ProviderWorkerArtifactQueue {
    add(name: string, data: {
        ai_task_id: string;
        enqueued_at: number;
    }, options?: {
        jobId?: string;
    }): Promise<unknown>;
}
export interface ProviderWorkerOptions {
    pollingTimeoutMs?: number;
}
export interface ProviderWorkerLogger {
    info(fields: Record<string, unknown>, message: string): void;
}
export declare class ProviderExecutionJobInvalidError extends Error {
    readonly code = "PROVIDER_EXECUTION_JOB_INVALID";
    constructor();
}
export declare class ProviderTaskNotFoundError extends Error {
    readonly aiTaskId: string;
    readonly code = "PROVIDER_TASK_NOT_FOUND";
    constructor(aiTaskId: string);
}
export declare class ProviderWorkerProcessor {
    private readonly taskRepository;
    private readonly logger?;
    private readonly providerExecutionQueue?;
    private readonly attemptRepository?;
    private readonly artifactProcessingQueue?;
    private readonly options;
    constructor(taskRepository: ProviderWorkerTaskRepository, logger?: ProviderWorkerLogger | undefined, providerExecutionQueue?: TaskSubmitQueue | undefined, attemptRepository?: ProviderWorkerAttemptRepository | undefined, artifactProcessingQueue?: ProviderWorkerArtifactQueue | undefined, options?: ProviderWorkerOptions);
    process(data: ProviderExecutionJob): Promise<AiTaskDocument>;
    private resolveProviderResult;
    private pollProviderResult;
    private applyResolvedProviderResult;
    private handleProviderResultFailure;
    private logTask;
    private loadTask;
    private handleProviderSubmitFailure;
}
