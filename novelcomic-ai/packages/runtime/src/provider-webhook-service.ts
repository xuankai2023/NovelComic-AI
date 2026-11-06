import type { AiTaskDocument, AiTaskError, JsonValue } from '@novelcomic/contracts';
import {
  getRemainingRobinProviders,
  parseCoreProviderWebhook,
  requireCoreModel,
  type CoreProviderCall,
  type CoreProviderResult,
  type ParsedCoreProviderWebhook,
} from '@novelcomic/core';
import { createHash } from 'node:crypto';

export type ProviderWebhookHeaders = Record<string, string | undefined>;

export interface ProviderWebhookHandleResult {
  status: 'accepted';
  provider: string;
  provider_status?: string;
}

export interface ProviderWebhookTaskRepository {
  requireByAiTaskId(aiTaskId: string): Promise<AiTaskDocument>;
  findByProviderRequestId?(providerRequestId: string): Promise<AiTaskDocument | null>;
  markProviderFailedAttempt?(input: ProviderWebhookFailedAttemptUpdate): Promise<AiTaskDocument>;
  applyProviderResult(aiTaskId: string, result: CoreProviderResult): Promise<AiTaskDocument>;
}

export interface ProviderWebhookFailedAttemptUpdate {
  ai_task_id: string;
  provider?: string;
  provider_model_id?: string;
  provider_request_id?: string;
  provider_status?: string;
  attempt: number;
  error: AiTaskError;
  skip_provider?: string;
  has_fallback: boolean;
}

export interface ProviderWebhookEventRepository {
  insert(input: ProviderWebhookEventRecord): Promise<{ inserted: boolean }>;
}

export interface ProviderWebhookEventRecord {
  ai_task_id: string;
  provider: string;
  provider_request_id?: string;
  event_id: string;
  event_type: string;
  provider_status?: string;
  normalized_status: CoreProviderResult['status'];
  raw_summary: JsonValue;
  signature_verified: boolean;
  received_at: Date;
}

export interface ProviderWebhookQueue {
  add(name: string, data: { ai_task_id: string; enqueued_at: number; skip_providers?: string[] }, options?: { jobId?: string }): Promise<unknown>;
}

export interface ProviderWebhookLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface ProviderWebhookServiceOptions {
  taskRepository?: ProviderWebhookTaskRepository;
  providerEventRepository?: ProviderWebhookEventRepository;
  providerExecutionQueue?: ProviderWebhookQueue;
  artifactProcessingQueue?: ProviderWebhookQueue;
  logger?: ProviderWebhookLogger;
}

export interface ProviderWebhookHandler {
  handleWebhook(
    provider: string,
    body: unknown,
    headers: ProviderWebhookHeaders,
  ): Promise<ProviderWebhookHandleResult>;
}

export class ProviderWebhookService implements ProviderWebhookHandler {
  constructor(private readonly options: ProviderWebhookServiceOptions = {}) {}

  public async handleWebhook(
    provider: string,
    body: unknown,
    headers: ProviderWebhookHeaders,
  ): Promise<ProviderWebhookHandleResult> {
    const payload = coerceJsonWebhookBody(body);
    const webhook = parseCoreProviderWebhook(provider, payload, headers);

    if (!this.options.taskRepository) {
      return acceptedResult(provider, webhook.provider_status);
    }

    const task = await this.resolveTask(webhook);
    const providerModelId = webhook.provider_model_id ?? task.provider_model_id;
    const call = findProviderCall(task.core_model_id, provider, providerModelId);
    const normalizedResult = call.normalizeResult(payload);
    const providerStatus = webhook.provider_status ?? normalizedResult.status;
    const eventId = webhook.event_id ?? buildDeterministicEventId(provider, webhook, payload);
    const eventType = webhook.event_type ?? providerStatus;
    const record = await this.recordEvent({
      ai_task_id: task.ai_task_id,
      provider,
      ...(webhook.provider_request_id ? { provider_request_id: webhook.provider_request_id } : {}),
      event_id: eventId,
      event_type: eventType,
      provider_status: providerStatus,
      normalized_status: normalizedResult.status,
      raw_summary: summarizeJson(payload),
      signature_verified: isSignatureVerified(provider, headers),
      received_at: new Date(),
    });

    if (!record.inserted || !isSameProviderAttempt(task, provider, providerModelId, webhook)) {
      return acceptedResult(provider, providerStatus);
    }

    if (isProviderResultAlreadyHandled(task)) {
      this.options.logger?.info(
        { ai_task_id: task.ai_task_id, status: task.status, event_id: eventId },
        'provider webhook ignored because task already advanced',
      );
      return acceptedResult(provider, providerStatus);
    }

    if (normalizedResult.status === 'failed') {
      await this.handleFailedResult(task, provider, providerModelId, webhook, normalizedResult);
      return acceptedResult(provider, providerStatus);
    }

    await this.applyResolvedProviderResult(task.ai_task_id, normalizedResult);
    return acceptedResult(provider, providerStatus);
  }

  private async resolveTask(webhook: ParsedCoreProviderWebhook): Promise<AiTaskDocument> {
    if (webhook.ai_task_id) {
      return this.options.taskRepository!.requireByAiTaskId(webhook.ai_task_id);
    }
    if (webhook.provider_request_id && this.options.taskRepository!.findByProviderRequestId) {
      const task = await this.options.taskRepository!.findByProviderRequestId(webhook.provider_request_id);
      if (task) {
        return task;
      }
    }
    throw new ProviderWebhookTaskNotFoundError(webhook.ai_task_id, webhook.provider_request_id);
  }

  private async recordEvent(input: ProviderWebhookEventRecord): Promise<{ inserted: boolean }> {
    if (!this.options.providerEventRepository) {
      return { inserted: true };
    }
    return this.options.providerEventRepository.insert(input);
  }

  private async applyResolvedProviderResult(
    aiTaskId: string,
    result: CoreProviderResult,
  ): Promise<AiTaskDocument> {
    const updatedTask = await this.options.taskRepository!.applyProviderResult(aiTaskId, result);
    if (result.status !== 'processing') {
      await this.options.artifactProcessingQueue?.add(
        'process',
        { ai_task_id: aiTaskId, enqueued_at: Date.now() },
        { jobId: `artifact-${aiTaskId}` },
      );
    }
    return updatedTask;
  }

  private async handleFailedResult(
    task: AiTaskDocument,
    provider: string,
    providerModelId: string | undefined,
    webhook: ParsedCoreProviderWebhook,
    result: CoreProviderResult,
  ): Promise<AiTaskDocument> {
    const failedProviderKey = providerModelId ? `${provider}:${providerModelId}` : provider;
    const skipProviders = [...new Set([...(task.skip_providers ?? []), failedProviderKey])];
    const remainingProviders = providerModelId
      ? getRemainingRobinProviders(task.core_model_id, provider, providerModelId, task.options)
        .filter((candidate) => !skipProviders.includes(`${candidate.provider}:${candidate.model_id}`))
      : [];

    if (remainingProviders.length > 0 && this.options.taskRepository!.markProviderFailedAttempt) {
      const updatedTask = await this.options.taskRepository!.markProviderFailedAttempt({
        ai_task_id: task.ai_task_id,
        provider,
        ...(providerModelId ? { provider_model_id: providerModelId } : {}),
        ...(webhook.provider_request_id ? { provider_request_id: webhook.provider_request_id } : {}),
        provider_status: webhook.provider_status ?? 'failed',
        attempt: task.attempt ?? task.attempts ?? 1,
        error: result.error ? toAiTaskError(result.error) : providerFailedError(),
        skip_provider: failedProviderKey,
        has_fallback: true,
      });
      const nextProvider = remainingProviders[0];
      if (nextProvider) {
        await this.options.providerExecutionQueue?.add(
          'submit',
          { ai_task_id: task.ai_task_id, enqueued_at: Date.now(), skip_providers: skipProviders },
          { jobId: `provider-${task.ai_task_id}-fallback-${nextProvider.provider}-${nextProvider.model_id}` },
        );
      }
      return updatedTask;
    }

    return this.applyResolvedProviderResult(task.ai_task_id, result);
  }
}

export class ProviderWebhookTaskNotFoundError extends Error {
  readonly code = 'PROVIDER_WEBHOOK_TASK_NOT_FOUND';

  constructor(readonly aiTaskId: string | undefined, readonly providerRequestId: string | undefined) {
    super(`Provider webhook could not resolve task: ${aiTaskId ?? providerRequestId ?? 'unknown'}`);
    this.name = 'ProviderWebhookTaskNotFoundError';
  }
}

export function coerceJsonWebhookBody(body: unknown): unknown {
  const parsedBody = parseJsonString(body);
  if (!isRecord(parsedBody)) {
    return parsedBody;
  }

  const data = parsedBody.data;
  const parsedData = parseJsonString(data);
  if (parsedData === data) {
    return parsedBody;
  }
  return { ...parsedBody, data: parsedData };
}

function isSameProviderAttempt(
  task: AiTaskDocument,
  provider: string,
  providerModelId: string | undefined,
  webhook: ParsedCoreProviderWebhook,
): boolean {
  if (task.provider && task.provider !== provider) {
    return false;
  }
  if (task.provider_model_id && providerModelId && task.provider_model_id !== providerModelId) {
    return false;
  }
  if (task.provider_request_id && webhook.provider_request_id && task.provider_request_id !== webhook.provider_request_id) {
    return false;
  }
  if (webhook.attempt !== undefined && task.attempt !== undefined && webhook.attempt !== task.attempt) {
    return false;
  }
  return true;
}

function isProviderResultAlreadyHandled(task: AiTaskDocument): boolean {
  return task.status !== 'waiting_provider';
}

function findProviderCall(modelId: string, provider: string, providerModelId: string | undefined): CoreProviderCall {
  const call = requireCoreModel(modelId).robin_calls?.find((candidate) => (
    candidate.provider === provider && (!providerModelId || candidate.model_id === providerModelId)
  ));
  if (!call) {
    throw new Error(`Provider call not found: ${provider}${providerModelId ? `:${providerModelId}` : ''}`);
  }
  return call;
}

function toAiTaskError(error: NonNullable<CoreProviderResult['error']>): AiTaskError {
  const output: AiTaskError = {
    code: error.code,
    message: error.message,
  };
  if (typeof error.retryable === 'boolean') {
    output.retryable = error.retryable;
  }
  if (error.details !== undefined) {
    output.details = error.details;
  }
  return output;
}

function providerFailedError(): AiTaskError {
  return {
    code: 'provider_result_failed',
    message: 'Provider returned a failed result',
    retryable: false,
  };
}

function buildDeterministicEventId(
  provider: string,
  webhook: ParsedCoreProviderWebhook,
  payload: unknown,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      provider,
      provider_request_id: webhook.provider_request_id,
      event_type: webhook.event_type,
      provider_status: webhook.provider_status,
      payload: summarizeJson(payload),
    }))
    .digest('hex');
}

function isSignatureVerified(provider: string, headers: ProviderWebhookHeaders): boolean {
  if (provider !== 'tencent') {
    return false;
  }
  return (headers['x-oc-signature-verified'] ?? '').toLowerCase() === 'true';
}

function summarizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(summarizeJson);
  }
  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[key] = summarizeJson(item);
    }
    return output;
  }
  return String(value);
}

function parseJsonString(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return parseJsonString(value.toString('utf8'));
  }
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function acceptedResult(provider: string, providerStatus: string | undefined): ProviderWebhookHandleResult {
  return providerStatus
    ? { status: 'accepted', provider, provider_status: providerStatus }
    : { status: 'accepted', provider };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
