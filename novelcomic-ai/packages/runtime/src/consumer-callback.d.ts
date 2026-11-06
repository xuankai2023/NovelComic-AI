import type { AiTaskDocument, AiTaskPublicWebhookPayload, AiTaskWebhookPayload, AiTaskStatus } from '@novelcomic/contracts';
export interface ConsumerCallbackTaskRepository {
    requireByAiTaskId(aiTaskId: string): Promise<AiTaskDocument>;
    updateStatus(aiTaskId: string, status: AiTaskStatus): Promise<void>;
}
export interface ConsumerCallbackServiceOptions {
    consumerWebhookSecret: string;
    requestTimeoutMs?: number;
    fetch?: typeof fetch;
    now?: () => Date;
}
export interface ConsumerCallbackDeliverOptions {
    callbackAttempt?: number;
}
export interface ConsumerCallbackDeliveryRepository {
    upsertDelivery(delivery: {
        ai_task_id: string;
        webhook_url: string;
        attempt: number;
        idempotency_key: string;
        raw_body: string;
        request_body_hash: string;
        status: 'succeeded' | 'failed';
        response_status?: number;
        response_body_summary?: string;
        created_at: Date;
        updated_at: Date;
    }): Promise<void>;
}
export declare class ConsumerCallbackDeliveryError extends Error {
    readonly retryable: boolean;
    readonly details: {
        ai_task_id: string;
        webhook_url: string;
        response_status?: number;
        response_body_summary?: string;
    };
    readonly code = "CONSUMER_CALLBACK_DELIVERY_FAILED";
    constructor(message: string, retryable: boolean, details: {
        ai_task_id: string;
        webhook_url: string;
        response_status?: number;
        response_body_summary?: string;
    });
}
export declare class ConsumerCallbackService {
    private readonly taskRepository;
    private readonly options;
    private readonly callbackDeliveryRepository?;
    constructor(taskRepository: ConsumerCallbackTaskRepository, options: ConsumerCallbackServiceOptions, callbackDeliveryRepository?: ConsumerCallbackDeliveryRepository | undefined);
    deliver(aiTaskId: string, deliverOptions?: ConsumerCallbackDeliverOptions): Promise<AiTaskPublicWebhookPayload>;
    markFailed(aiTaskId: string): Promise<void>;
    private recordDelivery;
}
export declare function createConsumerCallbackSignature(secret: string, timestamp: string, rawBody: string): string;
export declare function buildAiTaskWebhookPayload(task: AiTaskDocument, completedAt?: Date): AiTaskWebhookPayload;
export declare function buildAiTaskPublicWebhookPayload(payload: AiTaskWebhookPayload): AiTaskPublicWebhookPayload;
