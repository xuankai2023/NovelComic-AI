import type { SmokeJobInput, SmokeJobResult } from '@novelcomic/contracts';
import type { CoreProvider, MediaAssetResolveResult, MediaAssetResolver } from '@novelcomic/core';
import type { SimpleQueue } from './artifact-worker.js';
export * from './task-service.js';
export * from './state-machine.js';
export * from './provider-worker.js';
export * from './provider-webhook-service.js';
export * from './artifact-worker.js';
export * from './consumer-callback.js';
export * from './callback-worker.js';
export * from './feishu-webhook-client.js';
export * from './model-call-notifier.js';
export * from './feishu-notifier.js';
export declare function processSmokeJob(data: SmokeJobInput): Promise<SmokeJobResult>;
export type MediaVerificationStatus = 'pending' | 'processing' | 'active' | 'rejected' | 'failed' | 'unknown';
export type MediaFaceProviderRecord = {
    asset_id?: string;
    verification_status?: MediaVerificationStatus;
    sync_status?: string;
};
export interface MediaFaceVerificationRepository {
    findByMediaUrl(mediaUrl: string, provider: 'byteplus'): Promise<MediaFaceProviderRecord | null>;
    markProviderState(input: {
        media_url: string;
        provider: 'byteplus';
        verification_status: MediaVerificationStatus;
        sync_status: string;
        last_sync_error?: string | null;
    }): Promise<void>;
}
export interface BytePlusAssetClient {
    getAsset(assetId: string): Promise<{
        status: 'Active' | 'Failed' | 'Processing' | 'Pending';
        error?: string;
    }>;
}
export declare class MediaFaceVerificationWorkerProcessor {
    private readonly repository;
    private readonly bytePlusClient;
    private readonly queue?;
    private readonly options;
    constructor(repository: MediaFaceVerificationRepository, bytePlusClient: BytePlusAssetClient, queue?: SimpleQueue<{
        provider: "byteplus";
        media_url: string;
        asset_id: string;
        enqueued_at: number;
        attempts_started_at?: number;
    }> | undefined, options?: {
        pollDelayMs?: number;
        maxPollMs?: number;
    });
    process(data: {
        provider: 'byteplus';
        media_url: string;
        asset_id: string;
        enqueued_at: number;
        attempts_started_at?: number;
    }): Promise<void>;
}
export declare class MongoMediaAssetResolver implements MediaAssetResolver {
    private readonly repository;
    constructor(repository: MediaFaceVerificationRepository);
    resolveUrl(input: {
        provider: CoreProvider;
        media_url: string;
    }): Promise<MediaAssetResolveResult>;
}
