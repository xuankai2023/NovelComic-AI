import { config } from '@novelcomic/config';
import { MongoClient, type Db } from 'mongodb';
export * from './task-repository.js';
export * from './provider-event-repository.js';
export * from './callback-delivery-repository.js';
export type MongoResources = { client: MongoClient; db: Db };
export function createMongo(): MongoResources {
  const client = new MongoClient(config.MONGODB_URI, { appName: 'novelcomic' });
  return { client, db: client.db(config.MONGODB_DB) };
}
export async function connectMongo(): Promise<MongoResources> {
  const { client, db } = createMongo();
  await client.connect();
  return { client, db };
}
export async function pingMongo(db: Db): Promise<void> { await db.command({ ping: 1 }); }
export { COLLECTIONS } from './collections.js';
export { createMongoContext, ensureMongoIndexes, mediaFaceLocation } from './mongo.js';
export type { MongoContext } from './mongo.js';
