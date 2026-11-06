export interface ConsumerCallbackReplayQueue {
    add(name: string, data: {
        ai_task_id: string;
        enqueued_at: number;
    }, options?: {
        attempts?: number;
        jobId?: string;
    }): Promise<{
        id?: string | number | null;
    }>;
}
export declare function parseAiTaskIds(argv: string[]): string[];
export declare function callbackReplayJobId(aiTaskId: string, now: number): string;
export declare function responseLooksHealthy(ok: boolean, body: string, contentType: string | null): boolean;
export declare function consumerHealthy(healthUrl: string, fetchImpl?: typeof fetch): Promise<boolean>;
export declare function waitForConsumer(options: {
    healthUrl: string;
    waitMs: number;
    pollMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    check?: () => Promise<boolean>;
}): Promise<void>;
export declare function enqueueConsumerCallbackReplays(queue: ConsumerCallbackReplayQueue, taskIds: string[], now?: () => number): Promise<string[]>;
