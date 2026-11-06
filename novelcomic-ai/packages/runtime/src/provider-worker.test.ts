import type { AiTaskDocument } from '@novelcomic/contracts';
import { registerCoreModel, type CoreProviderResult, type CoreSubmitResult } from '@novelcomic/core';
import { describe, expect, it } from 'vitest';
import {
  ProviderExecutionJobInvalidError,
  ProviderTaskNotFoundError,
  ProviderWorkerProcessor,
} from './provider-worker.js';

function createTask(overrides: Partial<AiTaskDocument> = {}): AiTaskDocument {
  return {
    ai_task_id: 'task-1',
    status: 'queued',
    model_id: 'worker-model',
    core_model_id: 'worker-model',
    options: { prompt: 'hello' },
    webhook_url: 'https://consumer.test/v1/ai/tasks/callback',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function registerWorkerModel(): void {
  registerCoreModel({
    id: 'worker-model',
    displayName: 'Worker Model',
    robin_calls: [
      {
        provider: 'provider-a',
        model_id: 'provider-a-model',
        result_mode: 'webhook',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-a',
            model_id: 'provider-a-model',
            provider_request_id: 'request-a',
            status: 'submitted',
          };
        },
        normalizeResult(raw: unknown): CoreProviderResult {
          return raw as CoreProviderResult;
        },
      },
    ],
  });
}

function registerFallbackModel(): void {
  registerCoreModel({
    id: 'worker-fallback-model',
    displayName: 'Worker Fallback Model',
    robin_calls: [
      {
        provider: 'provider-a',
        model_id: 'provider-a-model',
        result_mode: 'webhook',
        async submit(): Promise<CoreSubmitResult> {
          throw new Error('provider-a unavailable');
        },
        normalizeResult(raw: unknown): CoreProviderResult {
          return raw as CoreProviderResult;
        },
      },
      {
        provider: 'provider-b',
        model_id: 'provider-b-model',
        result_mode: 'webhook',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-b',
            model_id: 'provider-b-model',
            provider_request_id: 'request-b',
            status: 'submitted',
          };
        },
        normalizeResult(raw: unknown): CoreProviderResult {
          return raw as CoreProviderResult;
        },
      },
    ],
  });
}

function registerImmediateModel(): void {
  registerCoreModel({
    id: 'worker-immediate-model',
    displayName: 'Worker Immediate Model',
    robin_calls: [
      {
        provider: 'provider-sync',
        model_id: 'provider-sync-model',
        result_mode: 'sync',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-sync',
            model_id: 'provider-sync-model',
            provider_request_id: 'request-sync',
            status: 'succeeded',
            result_mode: 'sync',
            immediateResult: { text: 'hello from provider' },
          } as CoreSubmitResult;
        },
        normalizeResult(raw: unknown): CoreProviderResult {
          return {
            status: 'succeeded',
            outputs: { output: (raw as { text: string }).text },
          };
        },
      },
    ],
  });
}

function registerPollingModel(status: CoreProviderResult['status'] = 'succeeded'): void {
  registerCoreModel({
    id: `worker-polling-model-${status}`,
    displayName: `Worker Polling Model ${status}`,
    robin_calls: [
      {
        provider: 'provider-poll',
        model_id: 'provider-poll-model',
        result_mode: 'polling',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-poll',
            model_id: 'provider-poll-model',
            provider_request_id: `request-poll-${status}`,
            status: 'submitted',
            result_mode: 'polling',
          };
        },
        async getResult() {
          return { status };
        },
        normalizeResult(raw: unknown): CoreProviderResult {
          const normalizedStatus = (raw as { status: CoreProviderResult['status'] }).status;
          if (normalizedStatus === 'failed') {
            return {
              status: 'failed',
              error: { code: 'provider_failed', message: 'provider failed', retryable: false },
            };
          }
          if (normalizedStatus === 'processing') {
            return { status: 'processing' };
          }
          return { status: 'succeeded', outputs: { output: 'polling done' } };
        },
      },
      {
        provider: 'provider-next',
        model_id: 'provider-next-model',
        result_mode: 'webhook',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-next',
            model_id: 'provider-next-model',
            provider_request_id: 'request-next',
            status: 'submitted',
          };
        },
        normalizeResult(raw: unknown): CoreProviderResult {
          return raw as CoreProviderResult;
        },
      },
    ],
  });
}

describe('ProviderWorkerProcessor', () => {
  it('submits a queued AI task and records provider metadata', async () => {
    registerWorkerModel();
    const task = createTask();
    const logs: unknown[] = [];
    const telemetry: unknown[] = [];
    const attempts: unknown[] = [];
    const processor = new ProviderWorkerProcessor(
      {
        async requireByAiTaskId(aiTaskId) {
          if (aiTaskId !== task.ai_task_id) {
            throw Object.assign(new Error('not found'), { code: 'AI_TASK_NOT_FOUND' });
          }
          return task;
        },
        async markProviderSubmitted(input) {
          const updated: AiTaskDocument = {
            ...task,
            status: 'waiting_provider',
            provider: input.provider,
            provider_model_id: input.provider_model_id,
            provider_status: input.provider_status,
            result_mode: input.result_mode,
            attempt: input.attempt,
            attempts: input.attempt,
          };
          if (input.provider_request_id) {
            updated.provider_request_id = input.provider_request_id;
          }
          return updated;
        },
        async markProviderFailedAttempt() {
          throw new Error('failure path should not be called');
        },
        async applyProviderResult() {
          throw new Error('provider result path should not be called');
        },
        async updateProviderTelemetry(aiTaskId, input) {
          telemetry.push({ aiTaskId, input });
        },
      },
      {
        info(fields) {
          logs.push(fields);
        },
      },
      undefined,
      {
        async upsertAttempt(input) {
          attempts.push(input);
        },
      },
    );

    await expect(processor.process({ ai_task_id: 'task-1' })).resolves.toMatchObject({
      ai_task_id: 'task-1',
      status: 'waiting_provider',
      provider: 'provider-a',
      provider_model_id: 'provider-a-model',
      provider_request_id: 'request-a',
      provider_status: 'submitted',
      result_mode: 'webhook',
      attempt: 1,
    });
    expect(logs).toMatchObject([
      { ai_task_id: 'task-1', model_id: 'worker-model', status: 'queued', queue_wait_ms: expect.any(Number) },
      {
        ai_task_id: 'task-1',
        provider: 'provider-a',
        provider_model_id: 'provider-a-model',
        provider_request_id: 'request-a',
        provider_status: 'submitted',
        result_mode: 'webhook',
        attempt: 1,
      },
    ]);
    expect(logs[0]).not.toHaveProperty('trace_id');
    expect(logs[1]).not.toHaveProperty('trace_id');
    expect(logs[1]).not.toHaveProperty('queue_wait_ms');
    expect(telemetry).toMatchObject([
      {
        aiTaskId: 'task-1',
        input: {
          provider: 'provider-a',
          provider_model_id: 'provider-a-model',
          provider_request_id: 'request-a',
          status: 'submitted',
          queue_wait_ms: expect.any(Number),
        },
      },
    ]);
    expect(attempts).toMatchObject([
      {
        ai_task_id: 'task-1',
        attempt: 1,
        provider: 'provider-a',
        provider_model_id: 'provider-a-model',
        provider_request_id: 'request-a',
        status: 'submitted',
        result_mode: 'webhook',
        submit_payload_summary: { prompt: 'hello' },
      },
    ]);
  });

  it('applies an immediate provider result and enqueues artifact processing', async () => {
    registerImmediateModel();
    const task = createTask({
      ai_task_id: 'task-immediate',
      model_id: 'worker-immediate-model',
      core_model_id: 'worker-immediate-model',
    });
    const artifacts: unknown[] = [];
    const processor = new ProviderWorkerProcessor(
      {
        async requireByAiTaskId(aiTaskId) {
          if (aiTaskId !== task.ai_task_id) {
            throw Object.assign(new Error('not found'), { code: 'AI_TASK_NOT_FOUND' });
          }
          return task;
        },
        async markProviderSubmitted(input) {
          return {
            ...task,
            status: 'waiting_provider',
            provider: input.provider,
            provider_model_id: input.provider_model_id,
            provider_request_id: input.provider_request_id,
            provider_status: input.provider_status,
            result_mode: input.result_mode,
            attempt: input.attempt,
          };
        },
        async markProviderFailedAttempt() {
          throw new Error('failure path should not be called');
        },
        async applyProviderResult(aiTaskId, result) {
          return {
            ...task,
            ai_task_id: aiTaskId,
            status: 'processing_artifacts',
            result: result.outputs,
            provider_status: result.status,
          };
        },
      },
      undefined,
      undefined,
      undefined,
      {
        async add(name, data, options) {
          artifacts.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
    );

    await expect(processor.process({ ai_task_id: task.ai_task_id })).resolves.toMatchObject({
      status: 'processing_artifacts',
      result: { output: 'hello from provider' },
      provider_status: 'succeeded',
    });
    expect(artifacts).toEqual([
      {
        name: 'process',
        data: { ai_task_id: 'task-immediate', enqueued_at: expect.any(Number) as number },
        options: { jobId: 'artifact-task-immediate' },
      },
    ]);
  });

  it('polls a polling provider result and enqueues artifact processing when it succeeds', async () => {
    registerPollingModel('succeeded');
    const task = createTask({
      ai_task_id: 'task-polling-succeeded',
      model_id: 'worker-polling-model-succeeded',
      core_model_id: 'worker-polling-model-succeeded',
    });
    const artifacts: unknown[] = [];
    const processor = new ProviderWorkerProcessor(
      {
        async requireByAiTaskId(aiTaskId) {
          if (aiTaskId !== task.ai_task_id) {
            throw Object.assign(new Error('not found'), { code: 'AI_TASK_NOT_FOUND' });
          }
          return task;
        },
        async markProviderSubmitted(input) {
          return {
            ...task,
            status: 'waiting_provider',
            provider: input.provider,
            provider_model_id: input.provider_model_id,
            provider_request_id: input.provider_request_id,
            provider_status: input.provider_status,
            result_mode: input.result_mode,
            attempt: input.attempt,
          };
        },
        async markProviderFailedAttempt() {
          throw new Error('failure path should not be called');
        },
        async applyProviderResult(aiTaskId, result) {
          return {
            ...task,
            ai_task_id: aiTaskId,
            status: 'processing_artifacts',
            result: result.outputs,
            provider_status: result.status,
          };
        },
      },
      undefined,
      undefined,
      undefined,
      {
        async add(name, data, options) {
          artifacts.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
    );

    await expect(processor.process({ ai_task_id: task.ai_task_id })).resolves.toMatchObject({
      status: 'processing_artifacts',
      result: { output: 'polling done' },
      provider_status: 'succeeded',
    });
    expect(artifacts).toHaveLength(1);
  });

  it('keeps a polling provider waiting without artifact processing when it is still processing', async () => {
    registerPollingModel('processing');
    const task = createTask({
      ai_task_id: 'task-polling-processing',
      model_id: 'worker-polling-model-processing',
      core_model_id: 'worker-polling-model-processing',
    });
    const artifacts: unknown[] = [];
    const processor = new ProviderWorkerProcessor(
      {
        async requireByAiTaskId(aiTaskId) {
          if (aiTaskId !== task.ai_task_id) {
            throw Object.assign(new Error('not found'), { code: 'AI_TASK_NOT_FOUND' });
          }
          return task;
        },
        async markProviderSubmitted(input) {
          return {
            ...task,
            status: 'waiting_provider',
            provider: input.provider,
            provider_model_id: input.provider_model_id,
            provider_request_id: input.provider_request_id,
            provider_status: input.provider_status,
            result_mode: input.result_mode,
            attempt: input.attempt,
          };
        },
        async markProviderFailedAttempt() {
          throw new Error('failure path should not be called');
        },
        async applyProviderResult(aiTaskId, result) {
          return {
            ...task,
            ai_task_id: aiTaskId,
            status: 'waiting_provider',
            provider_status: result.status,
          };
        },
      },
      undefined,
      undefined,
      undefined,
      {
        async add(name, data, options) {
          artifacts.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
    );

    await expect(processor.process({ ai_task_id: task.ai_task_id })).resolves.toMatchObject({
      status: 'waiting_provider',
      provider_status: 'processing',
    });
    expect(artifacts).toEqual([]);
  });

  it('falls back to the next robin provider when polling returns failed', async () => {
    registerPollingModel('failed');
    const task = createTask({
      ai_task_id: 'task-polling-failed',
      model_id: 'worker-polling-model-failed',
      core_model_id: 'worker-polling-model-failed',
    });
    const providerJobs: unknown[] = [];
    const artifacts: unknown[] = [];
    const processor = new ProviderWorkerProcessor(
      {
        async requireByAiTaskId(aiTaskId) {
          if (aiTaskId !== task.ai_task_id) {
            throw Object.assign(new Error('not found'), { code: 'AI_TASK_NOT_FOUND' });
          }
          return task;
        },
        async markProviderSubmitted(input) {
          return {
            ...task,
            status: 'waiting_provider',
            provider: input.provider,
            provider_model_id: input.provider_model_id,
            provider_request_id: input.provider_request_id,
            provider_status: input.provider_status,
            result_mode: input.result_mode,
            attempt: input.attempt,
          };
        },
        async markProviderFailedAttempt(input) {
          return {
            ...task,
            status: 'queued',
            provider: input.provider,
            provider_model_id: input.provider_model_id,
            provider_request_id: input.provider_request_id,
            provider_status: input.provider_status,
            attempt: input.attempt,
            error: input.error,
            skip_providers: input.skip_provider ? [input.skip_provider] : undefined,
          };
        },
        async applyProviderResult() {
          throw new Error('final provider result should not be applied while fallback is available');
        },
      },
      undefined,
      {
        async add(name, data, options) {
          providerJobs.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
      undefined,
      {
        async add(name, data, options) {
          artifacts.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
    );

    await expect(processor.process({ ai_task_id: task.ai_task_id })).resolves.toMatchObject({
      status: 'queued',
      provider: 'provider-poll',
      provider_model_id: 'provider-poll-model',
      provider_request_id: 'request-poll-failed',
      provider_status: 'failed',
      skip_providers: ['provider-poll:provider-poll-model'],
    });
    expect(providerJobs).toEqual([
      {
        name: 'submit',
        data: { ai_task_id: 'task-polling-failed', skip_providers: ['provider-poll:provider-poll-model'] },
        options: { jobId: 'provider-task-polling-failed-fallback-provider-next-provider-next-model' },
      },
    ]);
    expect(artifacts).toEqual([]);
  });

  it('rejects jobs without ai_task_id', async () => {
    const processor = new ProviderWorkerProcessor({
      async requireByAiTaskId() {
        throw new Error('repository should not be called');
      },
      async markProviderSubmitted() {
        throw new Error('repository should not be called');
      },
      async markProviderFailedAttempt() {
        throw new Error('repository should not be called');
      },
      async applyProviderResult() {
        throw new Error('repository should not be called');
      },
    });

    await expect(processor.process({ ai_task_id: ' ' })).rejects.toBeInstanceOf(
      ProviderExecutionJobInvalidError,
    );
  });

  it('rejects jobs for missing tasks', async () => {
    const processor = new ProviderWorkerProcessor({
      async requireByAiTaskId() {
        throw Object.assign(new Error('not found'), { code: 'AI_TASK_NOT_FOUND' });
      },
      async markProviderSubmitted() {
        throw new Error('repository should not be called');
      },
      async markProviderFailedAttempt() {
        throw new Error('repository should not be called');
      },
      async applyProviderResult() {
        throw new Error('repository should not be called');
      },
    });

    await expect(processor.process({ ai_task_id: 'missing-task' })).rejects.toBeInstanceOf(
      ProviderTaskNotFoundError,
    );
  });

  it('records a failed attempt and enqueues the next robin provider', async () => {
    registerFallbackModel();
    const task = createTask({
      ai_task_id: 'task-fallback',
      model_id: 'worker-fallback-model',
      core_model_id: 'worker-fallback-model',
    });
    const jobs: unknown[] = [];
    const processor = new ProviderWorkerProcessor(
      {
        async requireByAiTaskId(aiTaskId) {
          if (aiTaskId !== task.ai_task_id) {
            throw Object.assign(new Error('not found'), { code: 'AI_TASK_NOT_FOUND' });
          }
          return task;
        },
        async markProviderSubmitted() {
          throw new Error('success path should not be called');
        },
        async markProviderFailedAttempt(input) {
          const updated: AiTaskDocument = {
            ...task,
            status: input.has_fallback ? 'queued' : 'failed',
            attempt: input.attempt,
            attempts: input.attempt,
            error: input.error,
          };
          if (input.provider_status) {
            updated.provider_status = input.provider_status;
          }
          if (input.provider) {
            updated.provider = input.provider;
          }
          if (input.provider_model_id) {
            updated.provider_model_id = input.provider_model_id;
          }
          if (input.skip_provider) {
            updated.skip_providers = [input.skip_provider];
          }
          return updated;
        },
        async applyProviderResult() {
          throw new Error('provider result path should not be called');
        },
      },
      undefined,
      {
        async add(name, data, options) {
          jobs.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
    );

    await expect(processor.process({ ai_task_id: 'task-fallback' })).resolves.toMatchObject({
      status: 'queued',
      provider: 'provider-a',
      provider_model_id: 'provider-a-model',
      provider_status: 'failed',
      attempt: 1,
      skip_providers: ['provider-a:provider-a-model'],
    });
    expect(jobs).toEqual([
      {
        name: 'submit',
        data: { ai_task_id: 'task-fallback', skip_providers: ['provider-a:provider-a-model'] },
        options: { jobId: 'provider-task-fallback-fallback-provider-b-provider-b-model' },
      },
    ]);
  });

  it('does not fallback when the request pins a provider', async () => {
    registerFallbackModel();
    const task = createTask({
      ai_task_id: 'task-pinned',
      model_id: 'worker-fallback-model',
      core_model_id: 'worker-fallback-model',
      options: { prompt: 'hello', provider: 'provider-a' },
    });
    const jobs: unknown[] = [];
    const artifacts: unknown[] = [];
    const processor = new ProviderWorkerProcessor(
      {
        async requireByAiTaskId(aiTaskId) {
          if (aiTaskId !== task.ai_task_id) {
            throw Object.assign(new Error('not found'), { code: 'AI_TASK_NOT_FOUND' });
          }
          return task;
        },
        async markProviderSubmitted() {
          throw new Error('success path should not be called');
        },
        async markProviderFailedAttempt(input) {
          const updated: AiTaskDocument = {
            ...task,
            status: input.has_fallback ? 'queued' : 'failed',
            attempt: input.attempt,
            attempts: input.attempt,
            error: input.error,
          };
          if (input.provider_status) {
            updated.provider_status = input.provider_status;
          }
          if (input.provider) {
            updated.provider = input.provider;
          }
          if (input.provider_model_id) {
            updated.provider_model_id = input.provider_model_id;
          }
          if (input.skip_provider) {
            updated.skip_providers = [input.skip_provider];
          }
          return updated;
        },
        async applyProviderResult() {
          throw new Error('provider result path should not be called');
        },
      },
      undefined,
      {
        async add(name, data, options) {
          jobs.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
      undefined,
      {
        async add(name, data, options) {
          artifacts.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
    );

    await expect(processor.process({ ai_task_id: 'task-pinned' })).resolves.toMatchObject({
      status: 'failed',
      provider: 'provider-a',
      provider_model_id: 'provider-a-model',
      provider_status: 'failed',
      attempt: 1,
      skip_providers: ['provider-a:provider-a-model'],
    });
    expect(jobs).toEqual([]);
    expect(artifacts).toEqual([
      {
        name: 'process',
        data: { ai_task_id: 'task-pinned', enqueued_at: expect.any(Number) as number },
        options: { jobId: 'artifact-task-pinned' },
      },
    ]);
  });

  it('adds task.trace_id to provider logs and keeps queue wait on the task record', async () => {
    registerWorkerModel();
    const task = createTask({ trace_id: 'trace-run-1' });
    const logs: Array<Record<string, unknown>> = [];
    const telemetry: Array<{ queue_wait_ms?: number }> = [];
    const processor = new ProviderWorkerProcessor(
      {
        async requireByAiTaskId() {
          return task;
        },
        async markProviderSubmitted(input) {
          return { ...task, status: 'waiting_provider', attempt: input.attempt };
        },
        async markProviderFailedAttempt() {
          throw new Error('failure path should not be called');
        },
        async applyProviderResult() {
          throw new Error('provider result path should not be called');
        },
        async updateProviderTelemetry(_aiTaskId, input) {
          telemetry.push(input);
        },
      },
      {
        info(fields) {
          logs.push(fields);
        },
      },
    );

    await processor.process({ ai_task_id: task.ai_task_id });

    expect(logs.map((entry) => entry.trace_id)).toEqual(['trace-run-1', 'trace-run-1']);
    expect(logs[0]?.queue_wait_ms).toEqual(expect.any(Number));
    expect(logs[1]).not.toHaveProperty('queue_wait_ms');
    expect(telemetry[0]?.queue_wait_ms).toBe(logs[0]?.queue_wait_ms);
  });
});
