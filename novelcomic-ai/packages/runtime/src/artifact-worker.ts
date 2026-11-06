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
  add(name: string, data: T, options?: { jobId?: string }): Promise<unknown>;
}

export interface ArtifactModelCallNotifier {
  notifyOnce(aiTaskId: string): Promise<void>;
}

export interface ArtifactProcessingJob {
  ai_task_id: string;
  enqueued_at?: number;
}

export type ConsumerCallbackJob = { ai_task_id: string; enqueued_at: number };

export class ArtifactWorkerProcessor {
  public constructor(
    private readonly taskRepository: ArtifactTaskRepository,
    private readonly artifactStore: ArtifactStore,
    private readonly consumerCallbackQueue: SimpleQueue<ConsumerCallbackJob>,
    private readonly modelCallNotifier?: ArtifactModelCallNotifier,
  ) {}

  public async process(data: ArtifactProcessingJob): Promise<void> {
    const task = await this.taskRepository.requireByAiTaskId(data.ai_task_id);
    if (task.status === 'failed') {
      await this.taskRepository.updateStatus(task.ai_task_id, 'callback_pending');
      await this.taskRepository.updateProviderTelemetry?.(task.ai_task_id, {
        artifact_process_ms: 0,
        total_gateway_ms: Date.now() - task.created_at.getTime(),
      });
      await this.modelCallNotifier?.notifyOnce(task.ai_task_id);
      await this.enqueueCallback(task.ai_task_id);
      return;
    }

    await this.taskRepository.updateStatus(task.ai_task_id, 'processing_artifacts');
    const startedAt = Date.now();
    const result = await this.artifactStore.processResult(task.result);
    await this.taskRepository.updateResult(task.ai_task_id, result);
    await this.taskRepository.updateStatus(task.ai_task_id, 'callback_pending');
    await this.taskRepository.updateProviderTelemetry?.(task.ai_task_id, {
      artifact_process_ms: Date.now() - startedAt,
      total_gateway_ms: Date.now() - task.created_at.getTime(),
    });
    await this.modelCallNotifier?.notifyOnce(task.ai_task_id);
    await this.enqueueCallback(task.ai_task_id);
  }

  private async enqueueCallback(aiTaskId: string): Promise<void> {
    await this.consumerCallbackQueue.add(
      'deliver',
      { ai_task_id: aiTaskId, enqueued_at: Date.now() },
      { jobId: `callback-${aiTaskId}` },
    );
  }
}
