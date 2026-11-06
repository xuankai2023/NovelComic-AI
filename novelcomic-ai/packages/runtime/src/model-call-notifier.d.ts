import type { AiTaskDocument } from '@novelcomic/contracts';
import type { FeishuWebhookClient, RuntimeLogger } from './feishu-webhook-client.js';
export type ModelCallNotifierConfig = {
    MODEL_CALL_FEISHU_ENABLED: boolean;
    MODEL_CALL_FEISHU_WEBHOOK_URL?: string | undefined;
    MODEL_CALL_FEISHU_ENVIRONMENT: string;
};
type ModelCallTaskRepository = {
    claimModelCallNotification(aiTaskId: string): Promise<boolean>;
    markModelCallNotificationFailed(aiTaskId: string, error: string): Promise<void>;
    markModelCallNotificationSent(aiTaskId: string): Promise<void>;
    requireByAiTaskId(aiTaskId: string): Promise<AiTaskDocument>;
};
export declare class ModelCallNotifier {
    private readonly config;
    private readonly taskRepository;
    private readonly feishuClient;
    private readonly logger?;
    constructor(config: ModelCallNotifierConfig, taskRepository: ModelCallTaskRepository, feishuClient: Pick<FeishuWebhookClient, 'sendText'>, logger?: RuntimeLogger | undefined);
    notifyOnce(aiTaskId: string): Promise<void>;
}
export declare function buildModelCallNotificationText(config: ModelCallNotifierConfig, task: AiTaskDocument): string;
export {};
