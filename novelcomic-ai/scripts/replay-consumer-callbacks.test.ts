import { readFileSync } from 'node:fs';
import type { AiCallbackDeliveryDocument } from '@novelcomic/contracts';
import { CallbackDeliveryRepository } from '@novelcomic/db';
import { CONSUMER_CALLBACK_QUEUE_NAME } from '@novelcomic/queues';
import { describe, expect, it, vi } from 'vitest';

import {
  callbackReplayJobId,
  consumerHealthy,
  enqueueConsumerCallbackReplays,
  parseAiTaskIds,
  responseLooksHealthy,
  waitForConsumer,
  type ConsumerCallbackReplayQueue,
} from './replay-consumer-callbacks.ts';

const scriptSource = readFileSync(new URL('./replay-consumer-callbacks.ts', import.meta.url), 'utf8');

class MemoryCollection {
  readonly docs: AiCallbackDeliveryDocument[] = [];

  async insertOne(document: AiCallbackDeliveryDocument): Promise<void> {
    this.docs.push(document);
  }

  async updateOne(
    query: { ai_task_id?: string; attempt?: number },
    update: { $set?: AiCallbackDeliveryDocument },
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount: number }> {
    const found = this.docs.find(
      (document) => document.ai_task_id === query.ai_task_id && document.attempt === query.attempt,
    );
    if (found && update.$set) {
      Object.assign(found, update.$set);
      return { matchedCount: 1 };
    }
    if (options?.upsert && update.$set) {
      this.docs.push({ ...update.$set });
      return { matchedCount: 1 };
    }
    return { matchedCount: 0 };
  }

  find(query: { ai_task_id?: string }) {
    const matched = this.docs.filter((document) => document.ai_task_id === query.ai_task_id);
    return {
      sort() {
        return {
          async toArray() {
            return matched.map((document) => ({ ...document, _id: document.ai_task_id }));
          },
        };
      },
    };
  }
}

function delivery(idempotencyKey: string): AiCallbackDeliveryDocument {
  return {
    ai_task_id: 'task_1789052010251_abc',
    webhook_url: 'https://consumer.test/callbacks/models/novelcomic_ai',
    attempt: 1,
    idempotency_key: idempotencyKey,
    raw_body: '{}',
    request_body_hash: 'hash-1',
    status: 'succeeded',
    created_at: new Date('2026-09-30T00:00:00.000Z'),
    updated_at: new Date('2026-09-30T00:00:00.000Z'),
  };
}

describe('replay consumer callbacks', () => {
  it('parses ai_task_id arguments and ignores other tokens', () => {
    expect(parseAiTaskIds(['task_1', '--dry-run', 'note', 'task_2'])).toEqual(['task_1', 'task_2']);
    expect(parseAiTaskIds([])).toEqual([]);
  });

  it('enqueues a new consumer-callback job id and does not write node state', async () => {
    expect(CONSUMER_CALLBACK_QUEUE_NAME).toBe('consumer-callback');
    expect(scriptSource).toContain("const CONSUMER_CALLBACK_QUEUE_NAME = 'consumer-callback'");
    expect(scriptSource).toContain('createConsumerCallbackQueue');
    expect(scriptSource).not.toContain('flow_node_state');
    expect(scriptSource).not.toContain('mongodb');

    let clock = 1_000;
    const jobs: Array<{
      attempts?: number;
      data: { ai_task_id: string; enqueued_at: number };
      jobId?: string;
      name: string;
    }> = [];
    const queue: ConsumerCallbackReplayQueue = {
      async add(name, data, options) {
        jobs.push({ attempts: options?.attempts, data, jobId: options?.jobId, name });
        return { id: options?.jobId };
      },
    };

    const first = await enqueueConsumerCallbackReplays(queue, ['task_1789052010251_abc'], () => clock++);
    const second = await enqueueConsumerCallbackReplays(queue, ['task_1789052010251_abc'], () => clock++);

    expect(first).toEqual(['callback-replay-task_1789052010251_abc-1000']);
    expect(second).toEqual(['callback-replay-task_1789052010251_abc-1001']);
    expect(jobs).toEqual([
      {
        attempts: 5,
        data: { ai_task_id: 'task_1789052010251_abc', enqueued_at: 1000 },
        jobId: 'callback-replay-task_1789052010251_abc-1000',
        name: 'deliver',
      },
      {
        attempts: 5,
        data: { ai_task_id: 'task_1789052010251_abc', enqueued_at: 1001 },
        jobId: 'callback-replay-task_1789052010251_abc-1001',
        name: 'deliver',
      },
    ]);
    expect(jobs.every((job) => !('attempt' in job.data))).toBe(true);
    expect(callbackReplayJobId('task_1789052010251_abc', 1000)).toBe(first[0]);
  });

  it('keeps one delivery row when a new job id replays the same attempt', async () => {
    const collection = new MemoryCollection();
    const repository = new CallbackDeliveryRepository(collection as never);
    await repository.upsertDelivery(delivery('key-a'));
    await repository.upsertDelivery(delivery('key-b'));

    const rows = await repository.listByTask('task_1789052010251_abc');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempt: 1, idempotency_key: 'key-b' });
    expect(collection.docs).toHaveLength(1);
  });

  it('waits until the consumer health check succeeds', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    await expect(consumerHealthy('http://127.0.0.1:8001/health', fetchImpl)).resolves.toBe(true);
    expect(responseLooksHealthy(true, 'upstream 502', 'application/json')).toBe(false);

    let clock = 0;
    const checks = [false, true];
    await expect(
      waitForConsumer({
        check: async () => checks.shift() ?? false,
        healthUrl: 'http://127.0.0.1:8001/health',
        now: () => clock,
        pollMs: 5,
        sleep: async (ms) => {
          clock += ms;
        },
        waitMs: 20,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails when the consumer stays unhealthy', async () => {
    let clock = 0;
    await expect(
      waitForConsumer({
        check: async () => false,
        healthUrl: 'http://127.0.0.1:8001/health',
        now: () => clock,
        pollMs: 5,
        sleep: async (ms) => {
          clock += ms;
        },
        waitMs: 10,
      }),
    ).rejects.toThrow('consumer health check failed: http://127.0.0.1:8001/health');
  });
});
