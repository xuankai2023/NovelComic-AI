import type { JsonValue } from '@novelcomic/contracts';
import type { Collection, Db } from 'mongodb';
export declare const PROVIDER_EVENT_COLLECTION_NAME = "provider_events";
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
export declare class ProviderEventRepository {
    private readonly collection;
    constructor(dbOrCollection: Db | Collection<ProviderEventRecord>, options?: ProviderEventRepositoryOptions);
    ensureIndexes(): Promise<void>;
    insert(input: ProviderEventInsertInput): Promise<{
        inserted: boolean;
    }>;
}
