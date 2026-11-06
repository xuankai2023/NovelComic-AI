import type { AiCallbackDeliveryDocument } from '@novelcomic/contracts';
import type { Collection, Db, Document, WithId } from 'mongodb';

import { COLLECTIONS } from './collections.js';

export const AI_CALLBACK_DELIVERY_COLLECTION_NAME = COLLECTIONS.aiCallbackDelivery;

export interface CallbackDeliveryRepositoryOptions {
  collectionName?: string;
}

export class CallbackDeliveryRepository {
  private readonly collection: Collection<AiCallbackDeliveryDocument>;

  constructor(
    dbOrCollection: Db | Collection<AiCallbackDeliveryDocument>,
    options: CallbackDeliveryRepositoryOptions = {},
  ) {
    this.collection = isCollection(dbOrCollection)
      ? dbOrCollection
      : dbOrCollection.collection<AiCallbackDeliveryDocument>(
        options.collectionName ?? AI_CALLBACK_DELIVERY_COLLECTION_NAME,
      );
  }

  public async ensureIndexes(): Promise<void> {
    await Promise.all([
      safeCreateIndex(
        this.collection,
        { ai_task_id: 1, attempt: 1 },
        { unique: true, name: 'ai_task_callback_attempt_unique' },
      ),
      safeCreateIndex(this.collection, { ai_task_id: 1 }, { name: 'ai_task_callback_task_id' }),
      safeCreateIndex(this.collection, { status: 1 }, { name: 'ai_task_callback_status' }),
    ]);
  }

  public async upsertDelivery(delivery: AiCallbackDeliveryDocument): Promise<void> {
    await this.collection.updateOne(
      { ai_task_id: delivery.ai_task_id, attempt: delivery.attempt },
      { $set: delivery },
      { upsert: true },
    );
  }

  public async listByTask(aiTaskId: string): Promise<AiCallbackDeliveryDocument[]> {
    const deliveries = await this.collection.find({ ai_task_id: aiTaskId }).sort({ attempt: 1 }).toArray();
    return deliveries.map(stripMongoId);
  }
}

function isCollection(input: Db | Collection<AiCallbackDeliveryDocument>): input is Collection<AiCallbackDeliveryDocument> {
  return 'insertOne' in input && typeof input.insertOne === 'function';
}

function stripMongoId<T extends object>(document: WithId<T>): T {
  const { _id: ignored, ...rest } = document;
  void ignored;
  return rest as T;
}

async function safeCreateIndex<T extends Document>(
  collection: Collection<T>,
  indexSpec: Record<string, 1 | -1>,
  options: { unique?: boolean; sparse?: boolean; name: string },
): Promise<void> {
  try {
    await collection.createIndex(indexSpec, options);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 85 || error.code === 86)) {
      return;
    }
    throw error;
  }
}
