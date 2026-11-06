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

export async function notifyUnknownProviderReason(
  config: FeishuNotifierConfig,
  notice: UnknownProviderReasonNotice,
): Promise<void> {
  const webhookUrl = config.REASON_MAPPING_FEISHU_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  const text = [
    '[NovelComic AI] 未匹配的错误 reason，请补充 mapping',
    `error_code: ${notice.errorCode}`,
    notice.provider ? `provider: ${notice.provider}` : undefined,
    notice.modelId ? `model_id: ${notice.modelId}` : undefined,
    notice.aiTaskId ? `ai_task_id: ${notice.aiTaskId}` : undefined,
    `fingerprint: ${notice.fingerprint}`,
    `hit_count: ${notice.hitCount}`,
    `sanitized_message: ${notice.sanitizedMessage}`,
    `provider_message: ${notice.providerMessage.slice(0, 500)}`,
  ]
    .filter(Boolean)
    .join('\n');

  await new FeishuWebhookClient({
    webhookUrl,
    secret: config.REASON_MAPPING_FEISHU_SECRET,
    timeoutMs: config.REASON_MAPPING_FEISHU_TIMEOUT_MS,
  }).sendText({ text });
}

export class AlertFeishuNotifier {
  public constructor(
    private readonly config: FeishuNotifierConfig,
    private readonly client: Pick<FeishuWebhookClient, 'sendText'>,
    private readonly logger?: RuntimeLogger,
  ) {}

  public async notifyCallbackFailed(input: {
    aiTaskId: string;
    reason: string;
    attemptsMade: number;
  }): Promise<void> {
    if (!this.config.ALERT_FEISHU_ENABLED || !this.config.ALERT_FEISHU_WEBHOOK_URL) {
      return;
    }

    try {
      await this.client.sendText({
        atAll: true,
        text: [
          '=== NovelComic AI 回调最终失败 ===',
          `环境: ${this.config.MODEL_CALL_FEISHU_ENVIRONMENT}`,
          `AI任务ID: ${input.aiTaskId}`,
          `尝试次数: ${input.attemptsMade}`,
          `失败原因: ${input.reason}`,
        ].join('\n'),
      });
    } catch (error) {
      this.logger?.warn?.(
        { err: error, ai_task_id: input.aiTaskId },
        'alert.feishu.callback_dlq_failed',
      );
    }
  }
}
