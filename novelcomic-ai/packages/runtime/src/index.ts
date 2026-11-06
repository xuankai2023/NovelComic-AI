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

export async function processSmokeJob(data: SmokeJobInput): Promise<SmokeJobResult> {
  return { ok: true, message: data.message, processedAt: new Date().toISOString() };
}

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
  getAsset(assetId: string): Promise<{ status: 'Active' | 'Failed' | 'Processing' | 'Pending'; error?: string }>;
}

export class MediaFaceVerificationWorkerProcessor {
  public constructor(
    private readonly repository: MediaFaceVerificationRepository,
    private readonly bytePlusClient: BytePlusAssetClient,
    private readonly queue?: SimpleQueue<{
      provider: 'byteplus';
      media_url: string;
      asset_id: string;
      enqueued_at: number;
      attempts_started_at?: number;
    }>,
    private readonly options: { pollDelayMs?: number; maxPollMs?: number } = {},
  ) {}

  public async process(data: {
    provider: 'byteplus';
    media_url: string;
    asset_id: string;
    enqueued_at: number;
    attempts_started_at?: number;
  }): Promise<void> {
    const startedAt = data.attempts_started_at ?? Date.now();
    const maxPollMs = this.options.maxPollMs ?? 15 * 60 * 1000;
    const asset = await this.bytePlusClient.getAsset(data.asset_id);
    if (asset.status === 'Active') {
      await this.repository.markProviderState({
        media_url: data.media_url,
        provider: data.provider,
        verification_status: 'active',
        sync_status: 'synced',
        last_sync_error: null,
      });
      return;
    }
    if (asset.status === 'Failed') {
      await this.repository.markProviderState({
        media_url: data.media_url,
        provider: data.provider,
        verification_status: 'failed',
        sync_status: 'failed',
        last_sync_error: asset.error ?? 'BytePlus GetAsset failed',
      });
      return;
    }
    if (Date.now() - startedAt >= maxPollMs) {
      await this.repository.markProviderState({
        media_url: data.media_url,
        provider: data.provider,
        verification_status: 'unknown',
        sync_status: 'sync_failed',
        last_sync_error: 'BytePlus GetAsset polling timed out',
      });
      return;
    }
    await this.repository.markProviderState({
      media_url: data.media_url,
      provider: data.provider,
      verification_status: 'processing',
      sync_status: 'syncing',
      last_sync_error: null,
    });
    await this.queue?.add(
      'poll',
      { ...data, attempts_started_at: startedAt },
      { jobId: `media-face-${data.asset_id}-${Date.now()}` },
    );
  }
}

export class MongoMediaAssetResolver implements MediaAssetResolver {
  public constructor(private readonly repository: MediaFaceVerificationRepository) {}

  public async resolveUrl(input: {
    provider: CoreProvider;
    media_url: string;
  }): Promise<MediaAssetResolveResult> {
    if (input.provider !== 'byteplus') return { status: 'not_found' };
    const record = await this.repository.findByMediaUrl(input.media_url, 'byteplus');
    if (!record?.asset_id) return { status: 'not_found' };
    if (record.verification_status === 'active') {
      return {
        status: 'resolved',
        provider: 'byteplus',
        media_url: input.media_url,
        asset_id: record.asset_id,
        asset_uri: `asset://${record.asset_id}`,
      };
    }
    const result: MediaAssetResolveResult = {
      status: 'not_ready',
      provider: 'byteplus',
      media_url: input.media_url,
      asset_id: record.asset_id,
    };
    if (record.verification_status) result.verification_status = record.verification_status;
    if (record.sync_status) result.sync_status = record.sync_status;
    return result;
  }
}
