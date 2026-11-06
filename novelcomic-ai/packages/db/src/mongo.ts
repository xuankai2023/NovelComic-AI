import type { AiCallbackDeliveryDocument, AiTaskDocument } from '@novelcomic/contracts';
import { config } from '@novelcomic/config';
import { MongoClient, type Collection, type Db, type Document } from 'mongodb';

import { COLLECTIONS } from './collections.js';

export interface AiTaskAttemptDocument {
  ai_task_id: string;
  attempt: number;
}

export interface AiProviderEventDocument {
  provider: string;
  provider_request_id: string;
  event_id: string;
}

export interface MediaFaceVerificationDocument {
  media?: { url?: string };
  face_providers?: { byteplus?: { asset_id?: string } };
}

export type MongoCollections = {
  aiTask: Collection<AiTaskDocument>;
  aiTaskAttempt: Collection<AiTaskAttemptDocument>;
  aiProviderEvent: Collection<AiProviderEventDocument>;
  aiCallbackDelivery: Collection<AiCallbackDeliveryDocument>;
  providerReasonMapping: Collection<Document>;
  providerReasonUnknown: Collection<Document>;
  mediaFaceVerification: Collection<MediaFaceVerificationDocument>;
};

export type MongoContext = {
  client: MongoClient;
  db: Db;
  collections: MongoCollections;
};

export function mediaFaceLocation(
  defaultDbName: string,
  env: NodeJS.ProcessEnv = process.env,
): { dbName: string; collection: string } {
  const configuredDb = env.MEDIA_FACE_VERIFICATION_DB_NAME?.trim();
  const configuredCollection = env.MEDIA_FACE_VERIFICATION_COLLECTION?.trim();
  return {
    dbName: configuredDb || defaultDbName,
    collection: configuredCollection || COLLECTIONS.mediaFaceVerification,
  };
}

export async function createMongoContext(): Promise<MongoContext> {
  const client = new MongoClient(config.MONGODB_URI, { appName: 'novelcomic' });
  await client.connect();
  const db = client.db(config.MONGODB_DB);
  const mediaFace = mediaFaceLocation(config.MONGODB_DB);
  const mediaFaceDb = mediaFace.dbName === config.MONGODB_DB ? db : client.db(mediaFace.dbName);
  return {
    client,
    db,
    collections: {
      aiTask: db.collection<AiTaskDocument>(COLLECTIONS.aiTask),
      aiTaskAttempt: db.collection<AiTaskAttemptDocument>(COLLECTIONS.aiTaskAttempt),
      aiProviderEvent: db.collection<AiProviderEventDocument>(COLLECTIONS.aiProviderEvent),
      aiCallbackDelivery: db.collection<AiCallbackDeliveryDocument>(COLLECTIONS.aiCallbackDelivery),
      providerReasonMapping: db.collection<Document>(COLLECTIONS.providerReasonMapping),
      providerReasonUnknown: db.collection<Document>(COLLECTIONS.providerReasonUnknown),
      mediaFaceVerification: mediaFaceDb.collection<MediaFaceVerificationDocument>(mediaFace.collection),
    },
  };
}

export async function ensureMongoIndexes(context: MongoContext): Promise<void> {
  await Promise.all([
    context.collections.aiTask.createIndex({ ai_task_id: 1 }, { unique: true }),
    context.collections.aiTask.createIndex(
      { idempotency_key: 1 },
      {
        unique: true,
        partialFilterExpression: { idempotency_key: { $exists: true } },
      },
    ),
    context.collections.aiTask.createIndex({ provider: 1, provider_request_id: 1 }),
    context.collections.aiTask.createIndex({ status: 1, updated_at: 1 }),
    context.collections.aiTaskAttempt.createIndex({ ai_task_id: 1, attempt: 1 }, { unique: true }),
    context.collections.aiProviderEvent.createIndex(
      { provider: 1, provider_request_id: 1, event_id: 1 },
      { unique: true },
    ),
    context.collections.aiCallbackDelivery.createIndex({ ai_task_id: 1, attempt: 1 }, { unique: true }),
    context.collections.mediaFaceVerification.createIndex({ 'media.url': 1 }),
    context.collections.mediaFaceVerification.createIndex({ 'face_providers.byteplus.asset_id': 1 }),
    context.collections.mediaFaceVerification.createIndex({
      'media.url': 1,
      'face_providers.byteplus.asset_id': 1,
    }),
  ]);
}
