import { FeishuWebhookClient, type RuntimeLogger } from './feishu-webhook-client.js';
export type FeishuNotifierConfig = {
    MODEL_CALL_FEISHU_ENVIRONMENT: string;
    ALERT_FEISHU_ENABLED: boolean;
    ALERT_FEISHU_WEBHOOK_URL?: string | undefined;
    REASON_MAPPING_FEISHU_WEBHOOK_URL?: string | undefined;
    REASON_MAPPING_FEISHU_SECRET?: string | undefined;
    REASON_MAPPING_FEISHU_TIMEOUT_MS: number;
};
export type UnknownProviderReasonNotice = {
    fingerprint: string;
    errorCode: number;
    provider?: string | undefined;
    modelId?: string | undefined;
    aiTaskId?: string | undefined;
    sanitizedMessage: string;
    providerMessage: string;
    hitCount: number;
};
export declare function notifyUnknownProviderReason(config: FeishuNotifierConfig, notice: UnknownProviderReasonNotice): Promise<void>;
export declare class AlertFeishuNotifier {
    private readonly config;
    private readonly client;
    private readonly logger?;
    constructor(config: FeishuNotifierConfig, client: Pick<FeishuWebhookClient, 'sendText'>, logger?: RuntimeLogger | undefined);
    notifyCallbackFailed(input: {
        aiTaskId: string;
        reason: string;
        attemptsMade: number;
    }): Promise<void>;
}
