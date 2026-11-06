import type {
  AiTaskDocument,
  AiTaskPublicWebhookPayload,
  AiTaskWebhookPayload,
  AiTaskStatus,
} from '@novelcomic/contracts';
import {
  AiTaskPublicWebhookPayloadSchema,
  AiTaskWebhookPayloadSchema,
  NormalizedTaskResultSchema,
} from '@novelcomic/contracts';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { assertTaskStatusCanAdvance } from './state-machine.js';

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

export class ConsumerCallbackDeliveryError extends Error {
  readonly code = 'CONSUMER_CALLBACK_DELIVERY_FAILED';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly details: {
      ai_task_id: string;
      webhook_url: string;
      response_status?: number;
      response_body_summary?: string;
    },
  ) {
    super(message);
    this.name = 'ConsumerCallbackDeliveryError';
  }
}

export class ConsumerCallbackService {
  constructor(
    private readonly taskRepository: ConsumerCallbackTaskRepository,
    private readonly options: ConsumerCallbackServiceOptions,
    private readonly callbackDeliveryRepository?: ConsumerCallbackDeliveryRepository,
  ) {}

  public async deliver(
    aiTaskId: string,
    deliverOptions: ConsumerCallbackDeliverOptions = {},
  ): Promise<AiTaskPublicWebhookPayload> {
    const task = await this.taskRepository.requireByAiTaskId(aiTaskId);
    const internalPayload = buildAiTaskWebhookPayload(task, this.options.now?.() ?? new Date());
    const publicPayload = buildAiTaskPublicWebhookPayload(internalPayload);
    const rawBody = JSON.stringify(publicPayload);
    const timestamp = (this.options.now?.() ?? new Date()).toISOString();
    const signature = createConsumerCallbackSignature(this.options.consumerWebhookSecret, timestamp, rawBody);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 30_000);
    const idempotencyKey = `${randomUUID()}:${timestamp}`;

    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(task.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-oc-timestamp': timestamp,
          'x-oc-signature': signature,
          'x-oc-idempotency-key': idempotencyKey,
        },
        body: rawBody,
        signal: controller.signal,
      });
    } catch (error) {
      await this.recordDelivery({
        task,
        attempt: deliverOptions.callbackAttempt ?? 1,
        idempotencyKey,
        rawBody,
        status: 'failed',
        responseBodySummary: summarizeThrownError(error),
      });
      throw new ConsumerCallbackDeliveryError(
        'Consumer callback request failed',
        true,
        {
          ai_task_id: task.ai_task_id,
          webhook_url: task.webhook_url,
          response_body_summary: summarizeThrownError(error),
        },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const responseBodySummary = await summarizeResponse(response);
      await this.recordDelivery({
        task,
        attempt: deliverOptions.callbackAttempt ?? 1,
        idempotencyKey,
        rawBody,
        status: 'failed',
        responseStatus: response.status,
        responseBodySummary,
      });
      throw new ConsumerCallbackDeliveryError(
        `Consumer callback failed with status ${response.status}`,
        response.status >= 500 || response.status === 429,
        {
          ai_task_id: task.ai_task_id,
          webhook_url: task.webhook_url,
          response_status: response.status,
          response_body_summary: responseBodySummary,
        },
      );
    }

    await this.recordDelivery({
      task,
      attempt: deliverOptions.callbackAttempt ?? 1,
      idempotencyKey,
      rawBody,
      status: 'succeeded',
      responseStatus: response.status,
      responseBodySummary: await summarizeResponse(response),
    });
    const nextStatus = task.error ? 'failed' : 'succeeded';
    assertTaskStatusCanAdvance(task.status, nextStatus);
    await this.taskRepository.updateStatus(task.ai_task_id, nextStatus);
    return publicPayload;
  }

  public async markFailed(aiTaskId: string): Promise<void> {
    await this.taskRepository.updateStatus(aiTaskId, 'callback_failed');
  }

  private async recordDelivery(input: {
    task: AiTaskDocument;
    attempt: number;
    idempotencyKey: string;
    rawBody: string;
    status: 'succeeded' | 'failed';
    responseStatus?: number;
    responseBodySummary?: string;
  }): Promise<void> {
    if (!this.callbackDeliveryRepository) {
      return;
    }
    const now = this.options.now?.() ?? new Date();
    await this.callbackDeliveryRepository.upsertDelivery({
      ai_task_id: input.task.ai_task_id,
      webhook_url: input.task.webhook_url,
      attempt: input.attempt,
      idempotency_key: input.idempotencyKey,
      raw_body: input.rawBody,
      request_body_hash: createHash('sha256').update(input.rawBody).digest('hex'),
      status: input.status,
      ...(input.responseStatus !== undefined ? { response_status: input.responseStatus } : {}),
      ...(input.responseBodySummary !== undefined ? { response_body_summary: input.responseBodySummary } : {}),
      created_at: now,
      updated_at: now,
    });
  }
}

export function createConsumerCallbackSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function buildAiTaskWebhookPayload(task: AiTaskDocument, completedAt: Date = new Date()): AiTaskWebhookPayload {
  const result = task.result === undefined ? undefined : NormalizedTaskResultSchema.parse(task.result);
  return AiTaskWebhookPayloadSchema.parse({
    ai_task_id: task.ai_task_id,
    status: task.error ? 'failed' : toInternalWebhookStatus(task.status),
    model_id: task.model_id,
    ...(task.trace_id ? { trace_id: task.trace_id } : {}),
    ...(task.provider ? { provider: task.provider } : {}),
    ...(task.provider_model_id ? { provider_model_id: task.provider_model_id } : {}),
    ...(task.provider_request_id ? { provider_request_id: task.provider_request_id } : {}),
    ...(task.client_context ? { client_context: task.client_context } : {}),
    ...(result ? { result } : {}),
    ...(task.error ? { error: task.error } : {}),
    started_at: task.created_at.toISOString(),
    completed_at: completedAt.toISOString(),
  });
}

export function buildAiTaskPublicWebhookPayload(payload: AiTaskWebhookPayload): AiTaskPublicWebhookPayload {
  return AiTaskPublicWebhookPayloadSchema.parse({
    ai_task_id: payload.ai_task_id,
    status: payload.status === 'succeeded' ? 'success' : payload.status,
    model_id: payload.model_id,
    ...(payload.trace_id ? { trace_id: payload.trace_id } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.provider_model_id ? { provider_model_id: payload.provider_model_id } : {}),
    ...(payload.provider_request_id ? { provider_request_id: payload.provider_request_id } : {}),
    ...(payload.client_context ? { client_context: payload.client_context } : {}),
    ...(payload.result ? { result: payload.result } : {}),
    ...(payload.usage ? { usage: payload.usage } : {}),
    error: payload.error ?? null,
    started_at: payload.started_at,
    completed_at: payload.completed_at,
  });
}

function toInternalWebhookStatus(status: AiTaskStatus): AiTaskWebhookPayload['status'] {
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled') {
    return status;
  }
  return 'succeeded';
}

async function summarizeResponse(response: Response): Promise<string> {
  return (await response.text()).slice(0, 2_000);
}

function summarizeThrownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 2_000);
  }
  return String(error).slice(0, 2_000);
}
