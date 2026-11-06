export interface CallbackWorkerJob<TData> {
    id?: string;
    name: string;
    data: TData;
    attemptsMade: number;
    opts: {
        attempts?: number;
    };
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
    deliver(aiTaskId: string, options?: {
        callbackAttempt?: number;
    }): Promise<unknown>;
    markFailed(aiTaskId: string): Promise<void>;
}
export interface CallbackWorkerQueue<TData> {
    add(name: string, data: TData, options?: {
        jobId?: string;
    }): Promise<unknown>;
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
export declare class CallbackWorkerProcessor {
    private readonly callbackService;
    private readonly callbackDlqQueue;
    private readonly options;
    private readonly alertNotifier?;
    constructor(callbackService: CallbackWorkerCallbackService, callbackDlqQueue: CallbackWorkerQueue<CallbackDlqJobData>, options?: CallbackWorkerOptions, alertNotifier?: CallbackAlertNotifier | undefined);
    process(job: CallbackWorkerJob<ConsumerCallbackJobData>): Promise<void>;
    private isRetryWindowExpired;
}
