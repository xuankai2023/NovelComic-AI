import { describe, expect, it } from 'vitest';
import {
  AiTaskPublicWebhookPayloadSchema,
  AiTaskWebhookPayloadSchema,
} from './webhook.schema.js';

describe('AI task webhook schemas', () => {
  it('accepts an internal terminal callback payload', () => {
    expect(
      AiTaskWebhookPayloadSchema.parse({
        ai_task_id: 'task-1',
        status: 'succeeded',
        model_id: 'novelcomic-image',
        trace_id: 'trace-1',
        provider: 'kie',
        provider_model_id: 'kie-image-v1',
        provider_request_id: 'request-1',
        client_context: { run_id: 'run-1', node_id: 'node-1' },
        result: {
          output: 'done',
          artifacts: [{ type: 'image', url: 'https://cdn.test/out.png' }],
        },
        started_at: '2026-09-28T13:00:00.000Z',
        completed_at: '2026-09-28T13:00:03.000Z',
      }),
    ).toMatchObject({
      status: 'succeeded',
      result: { output: 'done' },
    });
  });

  it('keeps public payloads small and rejects internal-only fields', () => {
    const publicPayload = {
      ai_task_id: 'task-1',
      status: 'success',
      model_id: 'novelcomic-image',
      provider_request_id: 'request-1',
      client_context: { run_id: 'run-1' },
      result: { output: 'done' },
      error: null,
      started_at: '2026-09-28T13:00:00.000Z',
      completed_at: '2026-09-28T13:00:03.000Z',
    };

    expect(AiTaskPublicWebhookPayloadSchema.parse(publicPayload)).toMatchObject({
      status: 'success',
      error: null,
    });
    expect(() => (
      AiTaskPublicWebhookPayloadSchema.parse({ ...publicPayload, provider_status: 'raw-success' })
    )).toThrow();
  });

  it('uses failed as the public status for failed callbacks', () => {
    expect(
      AiTaskPublicWebhookPayloadSchema.parse({
        ai_task_id: 'task-failed',
        status: 'failed',
        model_id: 'novelcomic-image',
        error: { code: 'provider_failed', message: 'provider failed', retryable: false },
        started_at: '2026-09-28T13:00:00.000Z',
        completed_at: '2026-09-28T13:00:03.000Z',
      }),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'provider_failed' },
    });
  });
});
