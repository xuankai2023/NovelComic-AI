export type ArtifactTaskStatus = 'failed' | 'processing_artifacts' | 'callback_pending' | (string & {});
export type TaskStatus = ArtifactTaskStatus;
export type ArtifactTaskRecord = {
    ai_task_id: string;
    status: ArtifactTaskStatus;
    result?: unknown;
    created_at: Date;
};
export type TaskRecord = ArtifactTaskRecord;
export interface ArtifactTaskRepository {
    requireByAiTaskId(aiTaskId: string): Promise<ArtifactTaskRecord>;
    updateStatus(aiTaskId: string, status: ArtifactTaskStatus): Promise<void>;
    updateResult(aiTaskId: string, result: unknown): Promise<void>;
    updateProviderTelemetry?(aiTaskId: string, telemetry: Record<string, number | undefined>): Promise<void>;
}
export interface ArtifactStore {
    processResult(result: unknown): Promise<unknown>;
}
export interface SimpleQueue<T> {
    add(name: string, data: T, options?: {
        jobId?: string;
    }): Promise<unknown>;
}
export interface ArtifactModelCallNotifier {
    notifyOnce(aiTaskId: string): Promise<void>;
}
export interface ArtifactProcessingJob {
    ai_task_id: string;
    enqueued_at?: number;
}
export type ConsumerCallbackJob = {
    ai_task_id: string;
    enqueued_at: number;
};
export declare class ArtifactWorkerProcessor {
    private readonly taskRepository;
    private readonly artifactStore;
    private readonly consumerCallbackQueue;
    private readonly modelCallNotifier?;
    constructor(taskRepository: ArtifactTaskRepository, artifactStore: ArtifactStore, consumerCallbackQueue: SimpleQueue<ConsumerCallbackJob>, modelCallNotifier?: ArtifactModelCallNotifier | undefined);
    process(data: ArtifactProcessingJob): Promise<void>;
    private enqueueCallback;
}
