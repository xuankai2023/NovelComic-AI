import type { JsonValue } from '@novelcomic/contracts';
import type { Collection, Db, Document, WithId } from 'mongodb';
import { COLLECTIONS } from './collections.js';

export const PROVIDER_EVENT_COLLECTION_NAME = COLLECTIONS.aiProviderEvent;

export interface ProviderEventRecord {
  ai_task_id: string;
  provider: string;
  provider_request_id?: string;
  event_id: string;
  event_type: string;
  provider_status?: string;
  normalized_status: 'succeeded' | 'failed' | 'processing';
  raw_summary: JsonValue;
  signature_verified: boolean;
  received_at: Date;
  created_at: Date;
}

export interface ProviderEventInsertInput {
  ai_task_id: string;
  provider: string;
  provider_request_id?: string;
  event_id: string;
  event_type: string;
  provider_status?: string;
  normalized_status: 'succeeded' | 'failed' | 'processing';
  raw_summary: JsonValue;
  signature_verified: boolean;
  received_at: Date;
}

export interface ProviderEventRepositoryOptions {
  collectionName?: string;
}

export class ProviderEventRepository {
  private readonly collection: Collection<ProviderEventRecord>;

  constructor(dbOrCollection: Db | Collection<ProviderEventRecord>, options: ProviderEventRepositoryOptions = {}) {
    this.collection = isCollection(dbOrCollection)
      ? dbOrCollection
      : dbOrCollection.collection<ProviderEventRecord>(
        options.collectionName ?? PROVIDER_EVENT_COLLECTION_NAME,
      );
  }

  public async ensureIndexes(): Promise<void> {
    await Promise.all([
      safeCreateIndex(
        this.collection,
        { provider: 1, event_id: 1 },
        { unique: true, name: 'provider_event_unique' },
      ),
      safeCreateIndex(this.collection, { ai_task_id: 1 }, { name: 'provider_event_ai_task_id' }),
      safeCreateIndex(
        this.collection,
        { provider_request_id: 1 },
        { sparse: true, name: 'provider_event_request_id' },
      ),
      safeCreateIndex(this.collection, { received_at: 1 }, { name: 'provider_event_received_at' }),
    ]);
  }

  public async insert(input: ProviderEventInsertInput): Promise<{ inserted: boolean }> {
    try {
      await this.collection.insertOne({
        ...input,
        created_at: new Date(),
      });
      return { inserted: true };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return { inserted: false };
      }
      throw error;
    }
  }

  public async listByTask(aiTaskId: string): Promise<ProviderEventRecord[]> {
    const events = await this.collection.find({ ai_task_id: aiTaskId }).sort({ received_at: 1 }).toArray();
    return events.map(stripMongoId);
  }
}

function isCollection(input: Db | Collection<ProviderEventRecord>): input is Collection<ProviderEventRecord> {
  return 'insertOne' in input && typeof input.insertOne === 'function';
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
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

function stripMongoId<T extends object>(document: WithId<T>): T {
  const { _id: ignored, ...rest } = document;
  void ignored;
  return rest as T;
}
