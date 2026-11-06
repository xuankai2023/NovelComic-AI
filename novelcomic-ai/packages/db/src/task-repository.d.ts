import type { AiTaskDocument, AiTaskError, AiTaskStatus, JsonValue, ProviderTelemetry } from '@novelcomic/contracts';
import type { Collection, Db } from 'mongodb';
export declare const AI_TASK_COLLECTION_NAME = "ai_tasks";
export type CreateTaskResult = {
    status: 'created';
    task: AiTaskDocument;
} | {
    status: 'existing';
    task: AiTaskDocument;
};
export interface ProviderSubmittedUpdate {
    ai_task_id: string;
    provider: string;
    provider_model_id: string;
    provider_request_id?: string;
    provider_status: string;
    result_mode: 'sync' | 'polling' | 'webhook';
    attempt: number;
}
export interface ProviderFailedAttemptUpdate {
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
export interface ProviderResultUpdate {
    status: 'succeeded' | 'failed' | 'processing';
    outputs?: JsonValue;
    error?: AiTaskError;
}
export interface TaskRepositoryOptions {
    collectionName?: string;
}
export declare class AiTaskNotFoundError extends Error {
    readonly aiTaskId: string;
    readonly code = "AI_TASK_NOT_FOUND";
    constructor(aiTaskId: string);
}
export declare class TaskRepositoryConflictError extends Error {
    readonly code = "TASK_REPOSITORY_CONFLICT";
    constructor(message: string);
}
export declare class TaskRepository {
    private readonly collection;
    constructor(dbOrCollection: Db | Collection<AiTaskDocument>, options?: TaskRepositoryOptions);
    ensureIndexes(): Promise<void>;
    createOrGet(task: AiTaskDocument): Promise<CreateTaskResult>;
    getById(aiTaskId: string): Promise<AiTaskDocument | null>;
    requireByAiTaskId(aiTaskId: string): Promise<AiTaskDocument>;
    findByProviderRequestId(providerRequestId: string): Promise<AiTaskDocument | null>;
    updateStatus(aiTaskId: string, status: AiTaskStatus): Promise<void>;
    updateResult(aiTaskId: string, result: JsonValue): Promise<void>;
    updateProviderTelemetry(aiTaskId: string, telemetry: Partial<ProviderTelemetry>): Promise<void>;
    claimModelCallNotification(aiTaskId: string): Promise<boolean>;
    markModelCallNotificationSent(aiTaskId: string): Promise<void>;
    markModelCallNotificationFailed(aiTaskId: string, error: string): Promise<void>;
    markProviderSubmitted(input: ProviderSubmittedUpdate): Promise<AiTaskDocument>;
    markProviderFailedAttempt(input: ProviderFailedAttemptUpdate): Promise<AiTaskDocument>;
    applyProviderResult(aiTaskId: string, result: ProviderResultUpdate): Promise<AiTaskDocument>;
}
