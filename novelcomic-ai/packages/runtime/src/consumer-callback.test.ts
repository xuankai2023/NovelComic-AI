import type { AiTaskDocument, AiTaskStatus } from '@novelcomic/contracts';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TaskStatusTransitionError } from './state-machine.js';
import {
  buildAiTaskPublicWebhookPayload,
  buildAiTaskWebhookPayload,
  ConsumerCallbackDeliveryError,
  ConsumerCallbackService,
  createConsumerCallbackSignature,
} from './consumer-callback.js';

const completedAt = new Date('2026-09-28T13:00:03.000Z');

function createTask(overrides: Partial<AiTaskDocument> = {}): AiTaskDocument {
  return {
    ai_task_id: 'task-callback-1',
    status: 'callback_pending',
    model_id: 'novelcomic-image',
    core_model_id: 'novelcomic-image',
    options: { prompt: 'hello' },
    webhook_url: 'https://consumer.test/v1/ai/tasks/callback',
    trace_id: 'trace-1',
    client_context: { run_id: 'run-1', node_id: 'node-1' },
    provider: 'kie',
    provider_model_id: 'kie-image-v1',
    provider_request_id: 'request-1',
    result: {
      output: 'done',
      artifacts: [{ type: 'image', url: 'https://cdn.test/out.png' }],
    },
    created_at: new Date('2026-09-28T13:00:00.000Z'),
    updated_at: new Date('2026-09-28T13:00:02.000Z'),
    ...overrides,
  };
}

describe('ConsumerCallbackService', () => {
  it('builds internal and public callback payloads', () => {
    const internal = buildAiTaskWebhookPayload(createTask(), completedAt);
    const publicPayload = buildAiTaskPublicWebhookPayload(internal);

    expect(internal).toMatchObject({
      ai_task_id: 'task-callback-1',
      status: 'succeeded',
      provider_request_id: 'request-1',
      result: { output: 'done' },
    });
    expect(publicPayload).toMatchObject({
      ai_task_id: 'task-callback-1',
      status: 'success',
      client_context: { run_id: 'run-1', node_id: 'node-1' },
      result: { output: 'done' },
      error: null,
    });
    expect(publicPayload).not.toHaveProperty('core_model_id');
    expect(publicPayload).not.toHaveProperty('options');
  });

  it('posts the exact public raw body with HMAC headers and marks success on 2xx', async () => {
    const task = createTask();
    const statuses: AiTaskStatus[] = [];
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const deliveries: unknown[] = [];
    const service = new ConsumerCallbackService(
      {
        async requireByAiTaskId() {
          return task;
        },
        async updateStatus(_aiTaskId, status) {
          statuses.push(status);
        },
      },
      {
        consumerWebhookSecret: 'secret-1',
        now: () => completedAt,
        async fetch(url, init) {
          requests.push({ url: String(url), init: init ?? {} });
          return new Response(null, { status: 204 });
        },
      },
      {
        async upsertDelivery(delivery) {
          deliveries.push(delivery);
        },
      },
    );

    const payload = await service.deliver(task.ai_task_id, { callbackAttempt: 2 });

    expect(payload.status).toBe('success');
    expect(statuses).toEqual(['succeeded']);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const body = String(request.init.body);
    const headers = request.init.headers as Record<string, string>;
    expect(request.url).toBe(task.webhook_url);
    expect(JSON.parse(body)).toMatchObject({ ai_task_id: task.ai_task_id, status: 'success' });
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-oc-timestamp']).toBe(completedAt.toISOString());
    expect(headers['x-oc-signature']).toBe(
      createConsumerCallbackSignature('secret-1', completedAt.toISOString(), body),
    );
    expect(headers['x-oc-idempotency-key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:2026-09-28T13:00:03.000Z$/,
    );
    expect(deliveries).toMatchObject([
      {
        ai_task_id: task.ai_task_id,
        webhook_url: task.webhook_url,
        attempt: 2,
        raw_body: body,
        request_body_hash: createHash('sha256').update(body).digest('hex'),
        status: 'succeeded',
        response_status: 204,
        response_body_summary: '',
      },
    ]);
  });

  it('mints a new uuid:timestamp idempotency key on every callback delivery', async () => {
    const task = createTask();
    const keys: string[] = [];
    const service = new ConsumerCallbackService(
      {
        async requireByAiTaskId() {
          return task;
        },
        async updateStatus() {},
      },
      {
        consumerWebhookSecret: 'secret-1',
        now: () => completedAt,
        async fetch(_url, init) {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          keys.push(headers['x-oc-idempotency-key'] ?? '');
          return new Response(null, { status: 204 });
        },
      },
    );

    await service.deliver(task.ai_task_id);
    await service.deliver(task.ai_task_id);

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}:2026-09-28T13:00:03.000Z$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}:2026-09-28T13:00:03.000Z$/);
  });

  it('marks failed after a successful callback when the task has an error', async () => {
    const task = createTask({
      ai_task_id: 'task-failed',
      result: undefined,
      error: { code: 'provider_failed', message: 'provider failed', retryable: false },
    });
    const statuses: AiTaskStatus[] = [];
    const service = new ConsumerCallbackService(
      {
        async requireByAiTaskId() {
          return task;
        },
        async updateStatus(_aiTaskId, status) {
          statuses.push(status);
        },
      },
      {
        consumerWebhookSecret: 'secret-1',
        now: () => completedAt,
        async fetch() {
          return new Response('ok', { status: 200 });
        },
      },
    );

    await expect(service.deliver(task.ai_task_id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'provider_failed' },
    });
    expect(statuses).toEqual(['failed']);
  });

  it('does not mark a final status when the consumer returns non-2xx', async () => {
    const statuses: AiTaskStatus[] = [];
    const deliveries: unknown[] = [];
    const service = new ConsumerCallbackService(
      {
        async requireByAiTaskId() {
          return createTask();
        },
        async updateStatus(_aiTaskId, status) {
          statuses.push(status);
        },
      },
      {
        consumerWebhookSecret: 'secret-1',
        now: () => completedAt,
        async fetch() {
          return new Response('bad payload', { status: 400 });
        },
      },
      {
        async upsertDelivery(delivery) {
          deliveries.push(delivery);
        },
      },
    );

    await expect(service.deliver('task-callback-1', { callbackAttempt: 3 })).rejects.toBeInstanceOf(
      ConsumerCallbackDeliveryError,
    );
    expect(statuses).toEqual([]);
    expect(deliveries).toMatchObject([
      {
        ai_task_id: 'task-callback-1',
        attempt: 3,
        status: 'failed',
        response_status: 400,
        response_body_summary: 'bad payload',
      },
    ]);
  });

  it('keeps one delivery row for the same attempt when idempotency keys differ', async () => {
    const task = createTask();
    const keys: string[] = [];
    const rows = new Map<string, { attempt: number; idempotency_key: string }>();
    const service = new ConsumerCallbackService(
      {
        async requireByAiTaskId() {
          return task;
        },
        async updateStatus() {},
      },
      {
        consumerWebhookSecret: 'secret-1',
        now: () => completedAt,
        async fetch(_url, init) {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          keys.push(headers['x-oc-idempotency-key'] ?? '');
          return new Response(null, { status: 204 });
        },
      },
      {
        async upsertDelivery(delivery) {
          rows.set(`${delivery.ai_task_id}:${delivery.attempt}`, {
            attempt: delivery.attempt,
            idempotency_key: delivery.idempotency_key,
          });
        },
      },
    );

    await service.deliver(task.ai_task_id, { callbackAttempt: 1 });
    await service.deliver(task.ai_task_id, { callbackAttempt: 1 });

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}:2026-09-28T13:00:03.000Z$/);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}:2026-09-28T13:00:03.000Z$/);
    expect([...rows.keys()]).toEqual(['task-callback-1:1']);
    expect(rows.get('task-callback-1:1')?.idempotency_key).toBe(keys[1]);
  });

  it('does not write a status that cannot advance from a terminal task', async () => {
    const task = createTask({ status: 'succeeded', error: { code: 'late', message: 'late' } });
    const statuses: AiTaskStatus[] = [];
    const service = new ConsumerCallbackService(
      {
        async requireByAiTaskId() {
          return task;
        },
        async updateStatus(_aiTaskId, status) {
          statuses.push(status);
        },
      },
      {
        consumerWebhookSecret: 'secret-1',
        now: () => completedAt,
        async fetch() {
          return new Response(null, { status: 204 });
        },
      },
    );

    await expect(service.deliver(task.ai_task_id)).rejects.toBeInstanceOf(TaskStatusTransitionError);
    expect(statuses).toEqual([]);
  });
});
