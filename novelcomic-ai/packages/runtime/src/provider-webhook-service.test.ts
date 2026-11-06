import type { AiTaskDocument } from '@novelcomic/contracts';
import { registerCoreModel, type CoreProviderResult } from '@novelcomic/core';
import { describe, expect, it } from 'vitest';
import {
  ProviderWebhookService,
  type ProviderWebhookEventRecord,
  type ProviderWebhookFailedAttemptUpdate,
} from './provider-webhook-service.js';

function createTask(overrides: Partial<AiTaskDocument> = {}): AiTaskDocument {
  return {
    ai_task_id: 'task-webhook-1',
    status: 'waiting_provider',
    model_id: 'webhook-model',
    core_model_id: 'webhook-model',
    options: { prompt: 'hello' },
    webhook_url: 'https://consumer.test/callback',
    provider: 'provider-a',
    provider_model_id: 'provider-a-model',
    provider_request_id: 'request-a',
    provider_status: 'submitted',
    result_mode: 'webhook',
    attempt: 1,
    attempts: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function registerWebhookModel(): void {
  registerCoreModel({
    id: 'webhook-model',
    displayName: 'Webhook Model',
    robin_calls: [
      {
        provider: 'provider-a',
        model_id: 'provider-a-model',
        result_mode: 'webhook',
        async submit() {
          return {
            provider: 'provider-a',
            model_id: 'provider-a-model',
            provider_request_id: 'request-a',
            status: 'submitted',
          };
        },
        normalizeResult(raw: unknown): CoreProviderResult {
          const payload = raw as { status?: string; data?: { status?: string; output?: string } };
          const status = payload.data?.status ?? payload.status;
          if (status === 'failed') {
            return {
              status: 'failed',
              error: { code: 'provider_failed', message: 'provider failed', retryable: false },
            };
          }
          if (status === 'processing') {
            return { status: 'processing' };
          }
          return { status: 'succeeded', outputs: { output: payload.data?.output ?? 'done' } };
        },
      },
      {
        provider: 'provider-b',
        model_id: 'provider-b-model',
        result_mode: 'webhook',
        async submit() {
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

describe('ProviderWebhookService', () => {
  it('coerces JSON string bodies, parses JSON data, records the event, and enqueues artifacts', async () => {
    registerWebhookModel();
    const task = createTask();
    const events: ProviderWebhookEventRecord[] = [];
    const appliedResults: unknown[] = [];
    const artifacts: unknown[] = [];
    const service = new ProviderWebhookService({
      taskRepository: {
        async requireByAiTaskId(aiTaskId) {
          if (aiTaskId !== task.ai_task_id) {
            throw Object.assign(new Error('not found'), { code: 'AI_TASK_NOT_FOUND' });
          }
          return task;
        },
        async findByProviderRequestId(providerRequestId) {
          return providerRequestId === task.provider_request_id ? task : null;
        },
        async applyProviderResult(aiTaskId, result) {
          appliedResults.push({ aiTaskId, result });
          return {
            ...task,
            status: 'processing_artifacts',
            result: result.outputs,
            provider_status: result.status,
          };
        },
      },
      providerEventRepository: {
        async insert(input) {
          events.push(input);
          return { inserted: true };
        },
      },
      artifactProcessingQueue: {
        async add(name, data, options) {
          artifacts.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
    });

    await expect(
      service.handleWebhook(
        'provider-a',
        JSON.stringify({
          event_id: 'event-1',
          data: JSON.stringify({ request_id: 'request-a', status: 'succeeded', output: 'webhook done' }),
        }),
        { 'x-provider-signature': 'sig-1' },
      ),
    ).resolves.toMatchObject({
      status: 'accepted',
      provider: 'provider-a',
      provider_status: 'succeeded',
    });
    expect(events).toMatchObject([
      {
        ai_task_id: 'task-webhook-1',
        provider: 'provider-a',
        provider_request_id: 'request-a',
        event_id: 'event-1',
        event_type: 'succeeded',
        provider_status: 'succeeded',
        normalized_status: 'succeeded',
        signature_verified: false,
      },
    ]);
    expect(appliedResults).toMatchObject([
      {
        aiTaskId: 'task-webhook-1',
        result: { status: 'succeeded', outputs: { output: 'webhook done' } },
      },
    ]);
    expect(artifacts).toEqual([
      {
        name: 'process',
        data: { ai_task_id: 'task-webhook-1', enqueued_at: expect.any(Number) as number },
        options: { jobId: 'artifact-task-webhook-1' },
      },
    ]);
  });

  it('does not apply provider results twice when the same event is replayed', async () => {
    registerWebhookModel();
    const task = createTask({ ai_task_id: 'task-webhook-replay' });
    const seenEvents = new Set<string>();
    const appliedResults: unknown[] = [];
    const artifacts: unknown[] = [];
    const service = new ProviderWebhookService({
      taskRepository: {
        async requireByAiTaskId() {
          return task;
        },
        async applyProviderResult(aiTaskId, result) {
          appliedResults.push({ aiTaskId, result });
          return { ...task, status: 'processing_artifacts', result: result.outputs };
        },
      },
      providerEventRepository: {
        async insert(input) {
          const key = `${input.provider}:${input.event_id}`;
          const inserted = !seenEvents.has(key);
          seenEvents.add(key);
          return { inserted };
        },
      },
      artifactProcessingQueue: {
        async add(name, data, options) {
          artifacts.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
    });
    const payload = {
      ai_task_id: task.ai_task_id,
      event_id: 'event-replay',
      request_id: 'request-a',
      status: 'succeeded',
    };

    await service.handleWebhook('provider-a', payload, {});
    await service.handleWebhook('provider-a', payload, {});

    expect(appliedResults).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
  });

  it('records but ignores stale provider attempts', async () => {
    registerWebhookModel();
    const task = createTask({
      ai_task_id: 'task-webhook-stale',
      provider_request_id: 'request-current',
    });
    const events: ProviderWebhookEventRecord[] = [];
    const service = new ProviderWebhookService({
      taskRepository: {
        async requireByAiTaskId() {
          return task;
        },
        async applyProviderResult() {
          throw new Error('stale webhook should not be applied');
        },
      },
      providerEventRepository: {
        async insert(input) {
          events.push(input);
          return { inserted: true };
        },
      },
      artifactProcessingQueue: {
        async add() {
          throw new Error('stale webhook should not enqueue artifacts');
        },
      },
    });

    await service.handleWebhook('provider-a', {
      ai_task_id: task.ai_task_id,
      event_id: 'event-stale',
      request_id: 'request-old',
      status: 'succeeded',
    }, {});

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_id: 'event-stale', provider_request_id: 'request-old' });
  });

  it('records but ignores webhooks after polling already advanced the task', async () => {
    registerWebhookModel();
    const task = createTask({
      ai_task_id: 'task-webhook-polled',
      status: 'processing_artifacts',
      result: { output: 'polling done' },
    });
    const events: ProviderWebhookEventRecord[] = [];
    const service = new ProviderWebhookService({
      taskRepository: {
        async requireByAiTaskId() {
          return task;
        },
        async applyProviderResult() {
          throw new Error('already handled webhook should not be applied');
        },
      },
      providerEventRepository: {
        async insert(input) {
          events.push(input);
          return { inserted: true };
        },
      },
    });

    await service.handleWebhook('provider-a', {
      ai_task_id: task.ai_task_id,
      event_id: 'event-after-poll',
      request_id: 'request-a',
      status: 'succeeded',
    }, {});

    expect(events).toHaveLength(1);
  });

  it('falls back to the next robin provider when a webhook result fails', async () => {
    registerWebhookModel();
    const task = createTask({ ai_task_id: 'task-webhook-fallback' });
    const failedAttempts: ProviderWebhookFailedAttemptUpdate[] = [];
    const providerJobs: unknown[] = [];
    const service = new ProviderWebhookService({
      taskRepository: {
        async requireByAiTaskId() {
          return task;
        },
        async markProviderFailedAttempt(input) {
          failedAttempts.push(input);
          return {
            ...task,
            status: 'queued',
            error: input.error,
            skip_providers: input.skip_provider ? [input.skip_provider] : undefined,
          };
        },
        async applyProviderResult() {
          throw new Error('failed webhook should fallback before final result');
        },
      },
      providerEventRepository: {
        async insert() {
          return { inserted: true };
        },
      },
      providerExecutionQueue: {
        async add(name, data, options) {
          providerJobs.push({ name, data, options });
          return { id: options?.jobId ?? name };
        },
      },
    });

    await service.handleWebhook('provider-a', {
      ai_task_id: task.ai_task_id,
      event_id: 'event-failed',
      request_id: 'request-a',
      status: 'failed',
    }, {});

    expect(failedAttempts).toMatchObject([
      {
        ai_task_id: 'task-webhook-fallback',
        provider: 'provider-a',
        provider_model_id: 'provider-a-model',
        provider_request_id: 'request-a',
        provider_status: 'failed',
        skip_provider: 'provider-a:provider-a-model',
        has_fallback: true,
      },
    ]);
    expect(providerJobs).toEqual([
      {
        name: 'submit',
        data: {
          ai_task_id: 'task-webhook-fallback',
          enqueued_at: expect.any(Number) as number,
          skip_providers: ['provider-a:provider-a-model'],
        },
        options: { jobId: 'provider-task-webhook-fallback-fallback-provider-b-provider-b-model' },
      },
    ]);
  });

  it('records signature_verified only when Tencent verification succeeded', async () => {
    registerCoreModel({
      id: 'tencent-webhook-model',
      displayName: 'Tencent Webhook',
      robin_calls: [
        {
          provider: 'tencent',
          model_id: 'tencent-model',
          result_mode: 'webhook',
          async submit() {
            return { provider: 'tencent', model_id: 'tencent-model', status: 'submitted' };
          },
          normalizeResult(): CoreProviderResult {
            return { status: 'processing' };
          },
        },
      ],
    });
    const events: ProviderWebhookEventRecord[] = [];
    const task = createTask({
      ai_task_id: 'task-tencent',
      model_id: 'tencent-webhook-model',
      core_model_id: 'tencent-webhook-model',
      provider: 'tencent',
      provider_model_id: 'tencent-model',
      provider_request_id: 'request-tencent',
    });
    const service = new ProviderWebhookService({
      taskRepository: {
        async requireByAiTaskId() {
          return task;
        },
        async applyProviderResult() {
          return task;
        },
      },
      providerEventRepository: {
        async insert(input) {
          events.push(input);
          return { inserted: false };
        },
      },
    });

    await service.handleWebhook(
      'tencent',
      { ai_task_id: task.ai_task_id, event_id: 'evt-tencent', request_id: 'request-tencent', status: 'processing' },
      { 'x-oc-signature-verified': 'true' },
    );

    expect(events.map((event) => event.signature_verified)).toEqual([true]);
  });
});
