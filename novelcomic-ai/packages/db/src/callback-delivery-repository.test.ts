import type { AiCallbackDeliveryDocument } from '@novelcomic/contracts';
import { describe, expect, it } from 'vitest';

import {
  AI_CALLBACK_DELIVERY_COLLECTION_NAME,
  CallbackDeliveryRepository,
} from './callback-delivery-repository.js';

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

function delivery(overrides: Partial<AiCallbackDeliveryDocument> = {}): AiCallbackDeliveryDocument {
  return {
    ai_task_id: 'task-callback-1',
    webhook_url: 'https://consumer.test/callbacks/models/opencreator_ai',
    attempt: 1,
    idempotency_key: '11111111-1111-1111-1111-111111111111:2026-09-28T13:00:03.000Z',
    raw_body: '{}',
    request_body_hash: 'hash-1',
    status: 'succeeded',
    created_at: new Date('2026-09-28T13:00:03.000Z'),
    updated_at: new Date('2026-09-28T13:00:03.000Z'),
    ...overrides,
  };
}

describe('CallbackDeliveryRepository', () => {
  it('stores callback deliveries in ai_callback_delivery and collapses the same attempt', async () => {
    expect(AI_CALLBACK_DELIVERY_COLLECTION_NAME).toBe('ai_callback_delivery');
    const collection = new MemoryCollection();
    const repository = new CallbackDeliveryRepository(collection as never);
    const firstKey = '11111111-1111-1111-1111-111111111111:2026-09-28T13:00:03.000Z';
    const secondKey = '22222222-2222-2222-2222-222222222222:2026-09-28T13:00:04.000Z';

    await repository.upsertDelivery(delivery({ idempotency_key: firstKey }));
    await repository.upsertDelivery(
      delivery({
        idempotency_key: secondKey,
        updated_at: new Date('2026-09-28T13:00:04.000Z'),
      }),
    );
    await repository.upsertDelivery(delivery({ attempt: 2, idempotency_key: secondKey }));

    const rows = await repository.listByTask('task-callback-1');
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.attempt === 1)).toEqual([
      expect.objectContaining({
        ai_task_id: 'task-callback-1',
        attempt: 1,
        idempotency_key: secondKey,
      }),
    ]);
    expect(collection.docs.map((row) => [row.ai_task_id, row.attempt])).toEqual([
      ['task-callback-1', 1],
      ['task-callback-1', 2],
    ]);
  });
});
