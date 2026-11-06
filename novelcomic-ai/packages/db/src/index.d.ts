import { MongoClient, type Db } from 'mongodb';
export * from './task-repository.js';
export * from './provider-event-repository.js';
export * from './callback-delivery-repository.js';
export type MongoResources = {
    client: MongoClient;
    db: Db;
};
export declare function createMongo(): MongoResources;
export declare function connectMongo(): Promise<MongoResources>;
export declare function pingMongo(db: Db): Promise<void>;
export { COLLECTIONS } from './collections.js';
export { createMongoContext, ensureMongoIndexes, mediaFaceLocation } from './mongo.js';
export type { MongoContext } from './mongo.js';
