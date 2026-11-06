import type { AiCallbackDeliveryDocument, AiTaskDocument } from '@novelcomic/contracts';
import { MongoClient, type Collection, type Db, type Document } from 'mongodb';
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
    media?: {
        url?: string;
    };
    face_providers?: {
        byteplus?: {
            asset_id?: string;
        };
    };
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
export declare function mediaFaceLocation(defaultDbName: string, env?: NodeJS.ProcessEnv): {
    dbName: string;
    collection: string;
};
export declare function createMongoContext(): Promise<MongoContext>;
export declare function ensureMongoIndexes(context: MongoContext): Promise<void>;
