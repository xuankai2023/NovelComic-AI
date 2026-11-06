import type { AiTaskDocument } from '@novelcomic/contracts';
import { describe, expect, it } from 'vitest';
import { COLLECTIONS } from './collections.js';
import { AI_TASK_COLLECTION_NAME, TaskRepository } from './task-repository.js';

class DuplicateKeyError extends Error {
  readonly code = 11000;
}

class MemoryTasks {
  readonly docs: AiTaskDocument[] = [];

  async insertOne(document: AiTaskDocument): Promise<void> {
    if (this.docs.some((item) => item.idempotency_key === document.idempotency_key)) {
      throw new DuplicateKeyError('duplicate idempotency_key');
    }
    this.docs.push(document);
  }

  async findOne(query: { idempotency_key?: string }): Promise<AiTaskDocument | null> {
    return this.docs.find((item) => item.idempotency_key === query.idempotency_key) ?? null;
  }
}

function task(aiTaskId: string): AiTaskDocument {
  return {
    ai_task_id: aiTaskId,
    status: 'queued',
    model_id: 'novelcomic-image',
    core_model_id: 'novelcomic-image',
    options: { prompt: 'hello' },
    webhook_url: 'https://consumer.test/callback',
    idempotency_key: 'same-key',
    created_at: new Date('2026-09-30T00:00:00.000Z'),
    updated_at: new Date('2026-09-30T00:00:00.000Z'),
  };
}

describe('TaskRepository.createOrGet', () => {
  it('uses the unified ai_task collection name matching COLLECTIONS.aiTask', () => {
    expect(AI_TASK_COLLECTION_NAME).toBe('ai_task');
    expect(AI_TASK_COLLECTION_NAME).toBe(COLLECTIONS.aiTask);
  });

  it('returns the existing task when the idempotency key is repeated', async () => {
    const collection = new MemoryTasks();
    const repository = new TaskRepository(collection as never);
    const created = await repository.createOrGet(task('task-1'));
    const existing = await repository.createOrGet(task('task-2'));

    expect(created).toMatchObject({ status: 'created', task: { ai_task_id: 'task-1' } });
    expect(existing).toMatchObject({ status: 'existing', task: { ai_task_id: 'task-1' } });
    expect(collection.docs).toHaveLength(1);
  });
});
