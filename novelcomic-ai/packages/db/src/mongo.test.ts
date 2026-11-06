import { describe, expect, it } from 'vitest';

import { COLLECTIONS } from './collections.js';
import { ensureMongoIndexes, mediaFaceLocation, type MongoContext } from './mongo.js';

type IndexSpec = {
  keys: Array<[string, number]>;
  unique: boolean;
  partial?: Record<string, unknown>;
};

class DuplicateKeyError extends Error {
  constructor() {
    super('duplicate key');
    this.name = 'DuplicateKeyError';
  }
}

class FakeCollection {
  readonly indexes: IndexSpec[] = [];
  readonly docs: Array<Record<string, unknown>> = [];

  async createIndex(keys: Record<string, number>, options: { unique?: boolean; partialFilterExpression?: Record<string, unknown> } = {}): Promise<string> {
    const spec: IndexSpec = {
      keys: Object.entries(keys),
      unique: options.unique === true,
      ...(options.partialFilterExpression ? { partial: options.partialFilterExpression } : {}),
    };
    const same = this.indexes.find((item) => JSON.stringify(item) === JSON.stringify(spec));
    if (!same) {
      this.indexes.push(spec);
    }
    return spec.keys.map(([field]) => field).join('_');
  }

  async insertOne(document: Record<string, unknown>): Promise<void> {
    if (this.conflicts(document)) {
      throw new DuplicateKeyError();
    }
    this.docs.push({ ...document });
  }

  private conflicts(document: Record<string, unknown>): boolean {
    return this.indexes.some((index) => {
      if (!index.unique || !participates(document, index.partial)) {
        return false;
      }
      const key = JSON.stringify(index.keys.map(([field]) => readPath(document, field)));
      return this.docs.some((existing) => {
        if (!participates(existing, index.partial)) {
          return false;
        }
        return JSON.stringify(index.keys.map(([field]) => readPath(existing, field))) === key;
      });
    });
  }
}

function readPath(document: Record<string, unknown>, field: string): unknown {
  let current: unknown = document;
  for (const part of field.split('.')) {
    if (typeof current !== 'object' || current === null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function hasPath(document: Record<string, unknown>, field: string): boolean {
  let current: unknown = document;
  const parts = field.split('.');
  for (const part of parts.slice(0, -1)) {
    if (typeof current !== 'object' || current === null || !(part in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'object' && current !== null && parts.at(-1)! in current;
}

function participates(document: Record<string, unknown>, partial: Record<string, unknown> | undefined): boolean {
  if (!partial) {
    return true;
  }
  return Object.entries(partial).every(([field, expected]) => {
    if (typeof expected === 'object' && expected !== null && '$exists' in expected) {
      return Boolean(expected.$exists) === hasPath(document, field);
    }
    return true;
  });
}

function context(): { mongo: MongoContext; collections: Record<keyof MongoContext['collections'], FakeCollection> } {
  const collections = {
    aiTask: new FakeCollection(),
    aiTaskAttempt: new FakeCollection(),
    aiProviderEvent: new FakeCollection(),
    aiCallbackDelivery: new FakeCollection(),
    providerReasonMapping: new FakeCollection(),
    providerReasonUnknown: new FakeCollection(),
    mediaFaceVerification: new FakeCollection(),
  };
  return {
    collections,
    mongo: { collections } as unknown as MongoContext,
  };
}

describe('ensureMongoIndexes', () => {
  it('rejects a repeated ai_task_id and a repeated idempotency key', async () => {
    const { mongo, collections } = context();
    await ensureMongoIndexes(mongo);
    const indexCount = collections.aiTask.indexes.length;
    await ensureMongoIndexes(mongo);
    expect(collections.aiTask.indexes).toHaveLength(indexCount);

    const taskUnique = collections.aiTask.indexes.find((item) => item.keys[0]?.[0] === 'ai_task_id');
    expect(taskUnique).toMatchObject({ unique: true, keys: [['ai_task_id', 1]] });
    const idempotency = collections.aiTask.indexes.find((item) => item.keys[0]?.[0] === 'idempotency_key');
    expect(idempotency).toMatchObject({
      unique: true,
      partial: { idempotency_key: { $exists: true } },
    });
    expect(collections.aiTaskAttempt.indexes).toContainEqual({
      keys: [
        ['ai_task_id', 1],
        ['attempt', 1],
      ],
      unique: true,
    });
    expect(collections.aiProviderEvent.indexes).toContainEqual({
      keys: [
        ['provider', 1],
        ['provider_request_id', 1],
        ['event_id', 1],
      ],
      unique: true,
    });
    expect(collections.aiCallbackDelivery.indexes).toContainEqual({
      keys: [
        ['ai_task_id', 1],
        ['attempt', 1],
      ],
      unique: true,
    });

    await collections.aiTask.insertOne({ ai_task_id: 'task-1' });
    await expect(collections.aiTask.insertOne({ ai_task_id: 'task-1' })).rejects.toThrow('duplicate key');
    await collections.aiTask.insertOne({ ai_task_id: 'task-2' });
    await collections.aiTask.insertOne({ ai_task_id: 'task-3' });
    await collections.aiTask.insertOne({ ai_task_id: 'task-4', idempotency_key: 'same' });
    await expect(
      collections.aiTask.insertOne({ ai_task_id: 'task-5', idempotency_key: 'same' }),
    ).rejects.toThrow('duplicate key');
    expect(collections.aiTask.docs.map((item) => item.ai_task_id)).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
    ]);
  });

  it('indexes media face urls and asset ids without a user unique key', async () => {
    const { mongo, collections } = context();
    await ensureMongoIndexes(mongo);
    const keys = collections.mediaFaceVerification.indexes.map((item) => item.keys.map(([field]) => field));
    expect(keys).toEqual([
      ['media.url'],
      ['face_providers.byteplus.asset_id'],
      ['media.url', 'face_providers.byteplus.asset_id'],
    ]);
    expect(collections.mediaFaceVerification.indexes.every((item) => item.unique === false)).toBe(true);
    expect(JSON.stringify(keys)).not.toContain('user_id');
  });
});

describe('mediaFaceLocation', () => {
  it('uses the AI database unless a separate face database is configured', () => {
    expect(mediaFaceLocation('novelcomic', {})).toEqual({
      dbName: 'novelcomic',
      collection: COLLECTIONS.mediaFaceVerification,
    });
    expect(
      mediaFaceLocation('novelcomic', {
        MEDIA_FACE_VERIFICATION_DB_NAME: ' face-db ',
        MEDIA_FACE_VERIFICATION_COLLECTION: ' face_checks ',
      }),
    ).toEqual({ dbName: 'face-db', collection: 'face_checks' });
  });
});
