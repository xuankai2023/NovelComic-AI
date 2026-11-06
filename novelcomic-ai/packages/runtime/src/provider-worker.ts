import type { AiTaskDocument, AiTaskError } from '@novelcomic/contracts';
import {
  CoreProviderSubmitError,
  getRemainingRobinProviders,
  requireCoreModel,
  submitCoreTask,
  type CoreProviderCall,
  type CoreProviderResult,
  type CoreProviderResultMode,
  type CoreSubmitResult,
} from '@novelcomic/core';
import type { ProviderExecutionJob, TaskSubmitQueue } from './task-service.js';

export interface ProviderWorkerTaskRepository {
  requireByAiTaskId(aiTaskId: string): Promise<AiTaskDocument>;
  markProviderSubmitted(input: {
    ai_task_id: string;
    provider: string;
    provider_model_id: string;
    provider_request_id?: string;
    provider_status: string;
    result_mode: CoreProviderResultMode;
    attempt: number;
  }): Promise<AiTaskDocument>;
  markProviderFailedAttempt(input: {
    ai_task_id: string;
    provider?: string;
    provider_model_id?: string;
    provider_request_id?: string;
    provider_status?: string;
    attempt: number;
    error: AiTaskError;
    skip_provider?: string;
    has_fallback: boolean;
  }): Promise<AiTaskDocument>;
  applyProviderResult(aiTaskId: string, result: CoreProviderResult): Promise<AiTaskDocument>;
  updateProviderTelemetry?(aiTaskId: string, telemetry: ProviderWorkerTelemetryUpdate): Promise<void>;
}

export interface ProviderWorkerTelemetryUpdate {
  provider: string;
  provider_model_id: string;
  provider_request_id?: string;
  status: string;
  queue_wait_ms?: number;
  submit_duration_ms?: number;
}

export interface ProviderWorkerAttemptRepository {
  upsertAttempt(input: ProviderWorkerAttemptRecord): Promise<void>;
}

export interface ProviderWorkerAttemptRecord {
  ai_task_id: string;
  attempt: number;
  provider: string;
  provider_model_id: string;
  provider_request_id?: string;
  status: string;
  result_mode: CoreProviderResultMode;
  submit_payload_summary?: Record<string, unknown>;
  provider_response_summary?: unknown;
  started_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderWorkerArtifactQueue {
  add(name: string, data: { ai_task_id: string; enqueued_at: number }, options?: { jobId?: string }): Promise<unknown>;
}

export interface ProviderWorkerOptions {
  pollingTimeoutMs?: number;
}

export interface ProviderWorkerLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export class ProviderExecutionJobInvalidError extends Error {
  readonly code = 'PROVIDER_EXECUTION_JOB_INVALID';

  constructor() {
    super('Provider execution job requires ai_task_id');
    this.name = 'ProviderExecutionJobInvalidError';
  }
}

export class ProviderTaskNotFoundError extends Error {
  readonly code = 'PROVIDER_TASK_NOT_FOUND';

  constructor(readonly aiTaskId: string) {
    super(`Provider worker could not load AI task: ${aiTaskId}`);
    this.name = 'ProviderTaskNotFoundError';
  }
}

export class ProviderWorkerProcessor {
  constructor(
    private readonly taskRepository: ProviderWorkerTaskRepository,
    private readonly logger?: ProviderWorkerLogger,
    private readonly providerExecutionQueue?: TaskSubmitQueue,
    private readonly attemptRepository?: ProviderWorkerAttemptRepository,
    private readonly artifactProcessingQueue?: ProviderWorkerArtifactQueue,
    private readonly options: ProviderWorkerOptions = {},
  ) {}

  public async process(data: ProviderExecutionJob): Promise<AiTaskDocument> {
    const jobStartedAt = Date.now();
    const aiTaskId = typeof data.ai_task_id === 'string' ? data.ai_task_id.trim() : '';
    if (!aiTaskId) {
      throw new ProviderExecutionJobInvalidError();
    }

    const task = await this.loadTask(aiTaskId);
    const queueWaitMs = jobStartedAt - task.created_at.getTime();
    this.logTask(task, 'provider task loaded', {
      model_id: task.model_id,
      status: task.status,
      queue_wait_ms: queueWaitMs,
    });
    const attempt = (task.attempt ?? task.attempts ?? 0) + 1;

    try {
      const skipProviders = data.skip_providers ?? task.skip_providers;
      const submitStartedAt = Date.now();
      const submit = await submitCoreTask({
        ai_task_id: task.ai_task_id,
        model_id: task.core_model_id,
        options: task.options,
        webhook_url: task.webhook_url,
        ...(skipProviders ? { skip_providers: skipProviders } : {}),
      });
      const submitDurationMs = Date.now() - submitStartedAt;
      const providerRequestId = submit.provider_request_id ?? submit.request_id;
      const providerStatus = submit.provider_status ?? submit.status;
      const resultMode = submit.result_mode ?? 'webhook';
      const updatedTask = await this.taskRepository.markProviderSubmitted({
        ai_task_id: task.ai_task_id,
        provider: submit.provider,
        provider_model_id: submit.model_id,
        ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
        provider_status: providerStatus,
        result_mode: resultMode,
        attempt,
      });
      await this.taskRepository.updateProviderTelemetry?.(task.ai_task_id, {
        provider: submit.provider,
        provider_model_id: submit.model_id,
        ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
        status: providerStatus,
        queue_wait_ms: queueWaitMs,
        submit_duration_ms: submitDurationMs,
      });
      const now = new Date();
      await this.attemptRepository?.upsertAttempt({
        ai_task_id: task.ai_task_id,
        attempt,
        provider: submit.provider,
        provider_model_id: submit.model_id,
        ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
        status: providerStatus,
        result_mode: resultMode,
        submit_payload_summary: task.options,
        provider_response_summary: submit.raw,
        started_at: now,
        created_at: now,
        updated_at: now,
      });

      this.logTask(task, 'provider task submitted', {
        provider: submit.provider,
        provider_model_id: submit.model_id,
        provider_request_id: providerRequestId,
        provider_status: providerStatus,
        result_mode: resultMode,
        attempt,
      });
      const resolvedTask = await this.resolveProviderResult({
        task,
        data,
        attempt,
        submit,
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      return resolvedTask ?? updatedTask;
    } catch (error) {
      return this.handleProviderSubmitFailure(task, data, attempt, error);
    }
  }

  private async resolveProviderResult(input: {
    task: AiTaskDocument;
    data: ProviderExecutionJob;
    attempt: number;
    submit: CoreSubmitResult;
    providerRequestId?: string;
  }): Promise<AiTaskDocument | undefined> {
    const call = findProviderCall(input.task.core_model_id, input.submit.provider, input.submit.model_id);
    const immediate = readImmediateResult(input.submit);
    if (immediate) {
      const result = immediate.normalized ? immediate.result : call.normalizeResult(immediate.raw);
      return this.applyResolvedProviderResult(input.task.ai_task_id, result);
    }

    if (input.submit.result_mode !== 'polling') {
      return undefined;
    }

    const result = await this.pollProviderResult(call, input.submit, input.providerRequestId);
    if (result.status === 'failed') {
      return this.handleProviderResultFailure(input.task, input.data, input.attempt, input.submit, result);
    }
    return this.applyResolvedProviderResult(input.task.ai_task_id, result);
  }

  private async pollProviderResult(
    call: CoreProviderCall,
    submit: CoreSubmitResult,
    providerRequestId: string | undefined,
  ): Promise<CoreProviderResult> {
    if (!providerRequestId) {
      return {
        status: 'failed',
        error: {
          code: 'provider_request_id_missing',
          message: 'Polling provider did not return a provider_request_id',
          retryable: false,
        },
      };
    }

    if (!call.getResult) {
      return {
        status: 'failed',
        error: {
          code: 'provider_polling_unavailable',
          message: `Provider ${submit.provider}:${submit.model_id} does not support polling`,
          retryable: false,
        },
      };
    }

    try {
      const raw = await withTimeout(
        call.getResult({ request_id: providerRequestId, model_id: submit.model_id }),
        this.options.pollingTimeoutMs ?? 30_000,
      );
      return call.normalizeResult(raw);
    } catch (error) {
      return {
        status: 'failed',
        error: toAiTaskErrorWithCode(error, 'provider_polling_failed'),
      };
    }
  }

  private async applyResolvedProviderResult(
    aiTaskId: string,
    result: CoreProviderResult,
  ): Promise<AiTaskDocument> {
    const updatedTask = await this.taskRepository.applyProviderResult(aiTaskId, result);
    if (result.status !== 'processing') {
      await this.artifactProcessingQueue?.add(
        'process',
        { ai_task_id: aiTaskId, enqueued_at: Date.now() },
        { jobId: `artifact-${aiTaskId}` },
      );
    }
    return updatedTask;
  }

  private async handleProviderResultFailure(
    task: AiTaskDocument,
    data: ProviderExecutionJob,
    attempt: number,
    submit: CoreSubmitResult,
    result: CoreProviderResult,
  ): Promise<AiTaskDocument> {
    const failedProviderKey = `${submit.provider}:${submit.model_id}`;
    const skipProviders = [...new Set([
      ...(task.skip_providers ?? []),
      ...(data.skip_providers ?? []),
      failedProviderKey,
    ])];
    const remainingProviders = getRemainingRobinProviders(
      task.core_model_id,
      submit.provider,
      submit.model_id,
      task.options,
    ).filter((provider) => !skipProviders.includes(`${provider.provider}:${provider.model_id}`));

    if (remainingProviders.length > 0) {
      const updatedTask = await this.taskRepository.markProviderFailedAttempt({
        ai_task_id: task.ai_task_id,
        provider: submit.provider,
        provider_model_id: submit.model_id,
        ...(submit.provider_request_id ? { provider_request_id: submit.provider_request_id } : {}),
        provider_status: 'failed',
        attempt,
        error: result.error ? toAiTaskError(result.error) : toAiTaskError('Provider result failed'),
        skip_provider: failedProviderKey,
        has_fallback: true,
      });
      const nextProvider = remainingProviders[0];
      if (nextProvider && this.providerExecutionQueue) {
        await this.providerExecutionQueue.add(
          'submit',
          { ai_task_id: task.ai_task_id, skip_providers: skipProviders },
          { jobId: `provider-${task.ai_task_id}-fallback-${nextProvider.provider}-${nextProvider.model_id}` },
        );
      }
      return updatedTask;
    }

    return this.applyResolvedProviderResult(task.ai_task_id, result);
  }

  private logTask(task: AiTaskDocument, message: string, fields: Record<string, unknown>): void {
    const traceId = typeof task.trace_id === 'string' && task.trace_id.length > 0 ? task.trace_id : undefined;
    this.logger?.info(
      {
        ai_task_id: task.ai_task_id,
        ...(traceId ? { trace_id: traceId } : {}),
        ...fields,
      },
      message,
    );
  }

  private async loadTask(aiTaskId: string): Promise<AiTaskDocument> {
    try {
      return await this.taskRepository.requireByAiTaskId(aiTaskId);
    } catch (error) {
      if (isTaskNotFoundError(error)) {
        throw new ProviderTaskNotFoundError(aiTaskId);
      }
      throw error;
    }
  }

  private async handleProviderSubmitFailure(
    task: AiTaskDocument,
    data: ProviderExecutionJob,
    attempt: number,
    error: unknown,
  ): Promise<AiTaskDocument> {
    const providerError = error instanceof CoreProviderSubmitError ? error : undefined;
    const failedProviderKey = providerError ? `${providerError.provider}:${providerError.providerModelId}` : undefined;
    const skipProviders = [...new Set([
      ...(task.skip_providers ?? []),
      ...(data.skip_providers ?? []),
      ...(failedProviderKey ? [failedProviderKey] : []),
    ])];
    const remainingProviders = providerError
      ? getRemainingRobinProviders(
        task.core_model_id,
        providerError.provider,
        providerError.providerModelId,
        task.options,
      ).filter((provider) => !skipProviders.includes(`${provider.provider}:${provider.model_id}`))
      : [];
    const hasFallback = remainingProviders.length > 0;
    const updatedTask = await this.taskRepository.markProviderFailedAttempt({
      ai_task_id: task.ai_task_id,
      ...(providerError ? { provider: providerError.provider } : {}),
      ...(providerError ? { provider_model_id: providerError.providerModelId } : {}),
      provider_status: 'failed',
      attempt,
      error: toAiTaskError(providerError?.cause ?? error),
      ...(failedProviderKey ? { skip_provider: failedProviderKey } : {}),
      has_fallback: hasFallback,
    });

    if (hasFallback && this.providerExecutionQueue) {
      const nextProvider = remainingProviders[0];
      if (nextProvider) {
        await this.providerExecutionQueue.add(
          'submit',
          { ai_task_id: task.ai_task_id, skip_providers: skipProviders },
          { jobId: `provider-${task.ai_task_id}-fallback-${nextProvider.provider}-${nextProvider.model_id}` },
        );
        this.logTask(task, 'provider fallback enqueued', {
          failed_provider: providerError?.provider,
          failed_provider_model_id: providerError?.providerModelId,
          next_provider: nextProvider.provider,
          next_provider_model_id: nextProvider.model_id,
          skip_providers: skipProviders,
        });
      }
    }

    if (!hasFallback) {
      await this.artifactProcessingQueue?.add(
        'process',
        { ai_task_id: task.ai_task_id, enqueued_at: Date.now() },
        { jobId: `artifact-${task.ai_task_id}` },
      );
    }

    return updatedTask;
  }
}

function toAiTaskError(error: unknown): AiTaskError {
  if (isAiTaskError(error)) {
    const normalized: AiTaskError = {
      code: error.code,
      message: error.message,
    };
    if (typeof error.retryable === 'boolean') {
      normalized.retryable = error.retryable;
    }
    if (error.details !== undefined) {
      normalized.details = error.details;
    }
    return normalized;
  }

  if (error instanceof Error) {
    return {
      code: 'provider_submit_failed',
      message: error.message,
      retryable: false,
    };
  }

  return {
    code: 'provider_submit_failed',
    message: 'Provider submit failed',
    retryable: false,
  };
}

function toAiTaskErrorWithCode(error: unknown, code: string): NonNullable<CoreProviderResult['error']> {
  const normalized = toAiTaskError(error);
  const output: NonNullable<CoreProviderResult['error']> = {
    code,
    message: normalized.message,
  };
  if (typeof normalized.retryable === 'boolean') {
    output.retryable = normalized.retryable;
  }
  if (normalized.details !== undefined) {
    output.details = normalized.details;
  }
  return output;
}

function findProviderCall(modelId: string, provider: string, providerModelId: string): CoreProviderCall {
  const call = requireCoreModel(modelId).robin_calls?.find((candidate) => (
    candidate.provider === provider && candidate.model_id === providerModelId
  ));
  if (!call) {
    throw new Error(`Provider call not found: ${provider}:${providerModelId}`);
  }
  return call;
}

type ImmediateProviderResult =
  | { normalized: true; result: CoreProviderResult }
  | { normalized: false; raw: unknown };

function readImmediateResult(submit: CoreSubmitResult): ImmediateProviderResult | undefined {
  const extendedSubmit = submit as CoreSubmitResult & {
    immediateResult?: unknown;
    immediate_result?: unknown;
  };
  if (extendedSubmit.immediateResult !== undefined) {
    return { normalized: false, raw: extendedSubmit.immediateResult };
  }
  if (extendedSubmit.immediate_result !== undefined) {
    return { normalized: false, raw: extendedSubmit.immediate_result };
  }
  if (submit.result) {
    return { normalized: true, result: submit.result };
  }
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Provider polling timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isTaskNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'AI_TASK_NOT_FOUND';
}

function isAiTaskError(error: unknown): error is AiTaskError {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return false;
  }
  const record = error as Record<string, unknown>;
  return typeof record.code === 'string' && typeof record.message === 'string';
}
