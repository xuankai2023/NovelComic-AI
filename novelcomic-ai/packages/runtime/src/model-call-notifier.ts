import type { AiTaskDocument, ProviderTelemetryAttempt } from '@novelcomic/contracts';

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

export class ModelCallNotifier {
  public constructor(
    private readonly config: ModelCallNotifierConfig,
    private readonly taskRepository: ModelCallTaskRepository,
    private readonly feishuClient: Pick<FeishuWebhookClient, 'sendText'>,
    private readonly logger?: RuntimeLogger,
  ) {}

  public async notifyOnce(aiTaskId: string): Promise<void> {
    if (!this.config.MODEL_CALL_FEISHU_ENABLED) {
      this.logger?.info(
        {
          ai_task_id: aiTaskId,
          webhook_configured: Boolean(this.config.MODEL_CALL_FEISHU_WEBHOOK_URL),
          environment: this.config.MODEL_CALL_FEISHU_ENVIRONMENT,
        },
        'model call feishu notify skipped disabled',
      );
      return;
    }

    if (!this.config.MODEL_CALL_FEISHU_WEBHOOK_URL) {
      this.logger?.warn?.(
        { ai_task_id: aiTaskId, environment: this.config.MODEL_CALL_FEISHU_ENVIRONMENT },
        'model call feishu notify skipped missing webhook',
      );
      return;
    }

    const claimed = await this.taskRepository.claimModelCallNotification(aiTaskId);
    if (!claimed) {
      this.logger?.info({ ai_task_id: aiTaskId }, 'model call feishu notify skipped already claimed');
      return;
    }

    try {
      const task = await this.taskRepository.requireByAiTaskId(aiTaskId);
      await this.feishuClient.sendText({ text: buildModelCallNotificationText(this.config, task) });
      await this.taskRepository.markModelCallNotificationSent(aiTaskId);
      this.logger?.info({ ai_task_id: aiTaskId }, 'model call feishu notify sent');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.taskRepository.markModelCallNotificationFailed(aiTaskId, message);
      this.logger?.warn?.({ ai_task_id: aiTaskId, error: message }, 'model call feishu notify failed');
      throw error;
    }
  }
}

export function buildModelCallNotificationText(config: ModelCallNotifierConfig, task: AiTaskDocument): string {
  const context = task.client_context ?? {};
  const traceParts = typeof task.trace_id === 'string' ? task.trace_id.split(':') : [];
  const telemetry = task.provider_telemetry ?? {};
  const provider = telemetry.provider ?? task.provider ?? 'N/A';
  const providerModelId = telemetry.provider_model_id ?? task.provider_model_id ?? 'N/A';
  const providerRequestId = telemetry.provider_request_id ?? task.provider_request_id ?? 'N/A';
  const executionStatus = resolveExecutionStatus(task);
  const totalGatewayMs = telemetry.total_gateway_ms ?? dateDiffMs(task.created_at, task.updated_at);
  const attempts = telemetry.attempts ?? [];
  const fallbackAttempts = attempts.length > 1 ? attempts : [];

  const lines = [
    '=== NovelComic AI 原子执行完成 ===',
    `环境: ${config.MODEL_CALL_FEISHU_ENVIRONMENT}`,
    `节点ID: ${formatContextValue(context.node_id ?? traceParts[1])}`,
    `运行ID: ${formatContextValue(context.run_id ?? context.flow_task_id ?? traceParts[0])}`,
    `用户ID: ${formatContextValue(context.user_id)}`,
    `节点类型: ${formatContextValue(context.node_type)}`,
    `模型名称: ${formatContextValue(context.model_display_name ?? task.model_id)}`,
    `执行状态: ${executionStatus}`,
    `实际厂商: ${provider}`,
    `厂商模型: ${providerModelId}`,
    `厂商任务ID: ${providerRequestId}`,
    `网关排队耗时: ${formatDuration(telemetry.queue_wait_ms)}`,
    `提交耗时: ${formatDuration(telemetry.submit_duration_ms)}`,
    `厂商API耗时: ${formatDuration(telemetry.provider_duration_ms)}`,
    `文件处理耗时: ${formatDuration(telemetry.artifact_process_ms)}`,
    `网关总耗时: ${formatDuration(totalGatewayMs)}`,
    `AI任务ID: ${task.ai_task_id}`,
  ];

  if (fallbackAttempts.length > 0) {
    lines.push('Fallback尝试链路:');
    lines.push(...fallbackAttempts.map(formatFallbackAttempt));
  }

  return lines.join('\n');
}

function resolveExecutionStatus(task: AiTaskDocument): string {
  const telemetryStatus = task.provider_telemetry?.status;
  if (telemetryStatus === 'succeeded' || (task.result && !task.error)) return 'SUCCESS';
  if (telemetryStatus === 'failed' || task.error) return 'FAILED';
  if (telemetryStatus === 'timed_out') return 'TIMED_OUT';
  if (telemetryStatus === 'cancelled') return 'CANCELLED';
  return task.status.toUpperCase();
}

function formatFallbackAttempt(attempt: ProviderTelemetryAttempt): string {
  const provider = attempt.provider ?? 'N/A';
  const model = attempt.provider_model_id ?? 'N/A';
  const status = attempt.status ?? 'N/A';
  const duration = formatDuration(attempt.provider_duration_ms ?? attempt.total_duration_ms);
  const errorCode = attempt.error_code === undefined ? 'N/A' : String(attempt.error_code);
  const phase = attempt.phase ?? 'provider';
  return `- ${provider}/${model}/${status}/${duration}/${errorCode}/${phase}`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) {
    return 'N/A';
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function dateDiffMs(start: Date | undefined, end: Date | undefined): number | undefined {
  if (!start || !end) {
    return undefined;
  }
  return Math.max(0, end.getTime() - start.getTime());
}

function formatContextValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return 'N/A';
}
