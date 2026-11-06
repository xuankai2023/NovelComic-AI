export interface CallbackWorkerJob<TData> {
  id?: string;
  name: string;
  data: TData;
  attemptsMade: number;
  opts: { attempts?: number };
  timestamp: number;
}

export interface ConsumerCallbackJobData {
  ai_task_id: string;
  enqueued_at: number;
}

export interface CallbackDlqJobData {
  ai_task_id: string;
  failed_at: number;
  reason: string;
  attempts_made: number;
}

export interface CallbackWorkerCallbackService {
  deliver(aiTaskId: string, options?: { callbackAttempt?: number }): Promise<unknown>;
  markFailed(aiTaskId: string): Promise<void>;
}

export interface CallbackWorkerQueue<TData> {
  add(name: string, data: TData, options?: { jobId?: string }): Promise<unknown>;
}

export interface CallbackAlertNotifier {
  notifyCallbackFailed(input: {
    aiTaskId: string;
    reason: string;
    attemptsMade: number;
  }): Promise<void>;
}

export interface CallbackWorkerOptions {
  retryWindowMs?: number;
  now?: () => number;
}

export class CallbackWorkerProcessor {
  constructor(
    private readonly callbackService: CallbackWorkerCallbackService,
    private readonly callbackDlqQueue: CallbackWorkerQueue<CallbackDlqJobData>,
    private readonly options: CallbackWorkerOptions = {},
    private readonly alertNotifier?: CallbackAlertNotifier,
  ) {}

  public async process(job: CallbackWorkerJob<ConsumerCallbackJobData>): Promise<void> {
    try {
      await this.callbackService.deliver(job.data.ai_task_id, {
        callbackAttempt: job.attemptsMade + 1,
      });
    } catch (error) {
      const maxAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
      const currentAttempt = job.attemptsMade + 1;
      if (currentAttempt >= maxAttempts || this.isRetryWindowExpired(job)) {
        const failedAt = this.options.now?.() ?? Date.now();
        const reason = error instanceof Error ? error.message : String(error);
        await this.callbackService.markFailed(job.data.ai_task_id);
        await this.alertNotifier?.notifyCallbackFailed({
          aiTaskId: job.data.ai_task_id,
          reason,
          attemptsMade: currentAttempt,
        });
        await this.callbackDlqQueue.add(
          'failed',
          {
            ai_task_id: job.data.ai_task_id,
            failed_at: failedAt,
            reason,
            attempts_made: currentAttempt,
          },
          { jobId: `callback-dlq-${job.data.ai_task_id}` },
        );
      }
      throw error;
    }
  }

  private isRetryWindowExpired(job: CallbackWorkerJob<ConsumerCallbackJobData>): boolean {
    const retryWindowMs = this.options.retryWindowMs;
    if (retryWindowMs === undefined) {
      return false;
    }
    const firstAttemptAt = job.data.enqueued_at || job.timestamp;
    return (this.options.now?.() ?? Date.now()) - firstAttemptAt >= retryWindowMs;
  }
}
