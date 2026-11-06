import { describe, expect, it } from 'vitest';
import {
  ArtifactWorkerProcessor,
  MediaFaceVerificationWorkerProcessor,
  MongoMediaAssetResolver,
  processSmokeJob,
  type TaskRecord,
} from './index.js';
describe('processSmokeJob', () => {
  it('echoes a smoke message and completes it', async () => {
    const result = await processSmokeJob({ message: 'hello' });
    expect(result.ok).toBe(true); expect(result.message).toBe('hello'); expect(Number.isNaN(Date.parse(result.processedAt))).toBe(false);
  });
});

describe('MongoMediaAssetResolver', () => {
  it('returns asset uri only for active byteplus records', async () => {
    const resolver = new MongoMediaAssetResolver({
      async findByMediaUrl() {
        return { asset_id: 'asset-1', verification_status: 'active', sync_status: 'synced' };
      },
      async markProviderState() {},
    });

    await expect(resolver.resolveUrl({ provider: 'byteplus', media_url: 'https://cdn.test/a.png' })).resolves.toMatchObject({
      status: 'resolved',
      asset_uri: 'asset://asset-1',
    });
    await expect(resolver.resolveUrl({ provider: 'kie', media_url: 'https://cdn.test/a.png' })).resolves.toEqual({
      status: 'not_found',
    });
  });
});

describe('MediaFaceVerificationWorkerProcessor', () => {
  it('writes active, failed, and unknown states without touching ai tasks', async () => {
    const updates: unknown[] = [];
    const repository = {
      async findByMediaUrl() {
        return null;
      },
      async markProviderState(input: unknown) {
        updates.push(input);
      },
    };
    const processor = new MediaFaceVerificationWorkerProcessor(
      repository,
      { async getAsset() { return { status: 'Active' as const }; } },
      undefined,
      { maxPollMs: 0 },
    );

    await processor.process({
      provider: 'byteplus',
      media_url: 'https://cdn.test/a.png',
      asset_id: 'asset-1',
      enqueued_at: Date.now(),
    });
    const failedProcessor = new MediaFaceVerificationWorkerProcessor(
      repository,
      { async getAsset() { return { status: 'Failed' as const, error: 'bad media' }; } },
    );
    await failedProcessor.process({
      provider: 'byteplus',
      media_url: 'https://cdn.test/b.png',
      asset_id: 'asset-2',
      enqueued_at: Date.now(),
    });
    const unknownProcessor = new MediaFaceVerificationWorkerProcessor(
      repository,
      { async getAsset() { return { status: 'Processing' as const }; } },
      undefined,
      { maxPollMs: 0 },
    );
    await unknownProcessor.process({
      provider: 'byteplus',
      media_url: 'https://cdn.test/c.png',
      asset_id: 'asset-3',
      enqueued_at: Date.now(),
      attempts_started_at: Date.now() - 1,
    });

    expect(updates).toMatchObject([
      { verification_status: 'active', sync_status: 'synced' },
      { verification_status: 'failed', sync_status: 'failed' },
      { verification_status: 'unknown', sync_status: 'sync_failed' },
    ]);
  });
});

describe('ArtifactWorkerProcessor', () => {
  it('processes successful task artifacts, saves the stable result, and enqueues callback', async () => {
    const task: TaskRecord = {
      ai_task_id: 'task-success',
      status: 'processing_artifacts',
      result: { output: 'done', artifacts: [{ type: 'image', url: 'https://vendor.test/out.png' }] },
      created_at: new Date(),
    };
    const statuses: string[] = [];
    const results: unknown[] = [];
    const telemetry: unknown[] = [];
    const queueJobs: unknown[] = [];
    const processor = new ArtifactWorkerProcessor(
      {
        async requireByAiTaskId() { return task; },
        async updateStatus(_id, status) { statuses.push(status); },
        async updateResult(_id, result) { results.push(result); },
        async updateProviderTelemetry(_id, input) { telemetry.push(input); },
      },
      {
        async processResult(result) {
          return {
            ...(result as Record<string, unknown>),
            artifacts: [{ type: 'image', url: 'https://cdn.test/out.png' }],
          };
        },
      },
      {
        async add(name, data, options) {
          queueJobs.push({ name, data, options });
          return null;
        },
      },
    );

    await processor.process({ ai_task_id: 'task-success' });

    expect(statuses).toEqual(['processing_artifacts', 'callback_pending']);
    expect(results).toEqual([
      { output: 'done', artifacts: [{ type: 'image', url: 'https://cdn.test/out.png' }] },
    ]);
    expect(telemetry).toMatchObject([{ artifact_process_ms: expect.any(Number), total_gateway_ms: expect.any(Number) }]);
    expect(queueJobs).toEqual([
      {
        name: 'deliver',
        data: { ai_task_id: 'task-success', enqueued_at: expect.any(Number) as number },
        options: { jobId: 'callback-task-success' },
      },
    ]);
  });

  it('skips artifact processing for failed tasks and enqueues callback', async () => {
    const task: TaskRecord = {
      ai_task_id: 'task-1',
      status: 'failed',
      result: { url: 'https://vendor.test/out.png' },
      created_at: new Date(),
    };
    const statuses: string[] = [];
    const queueJobs: unknown[] = [];
    const processor = new ArtifactWorkerProcessor(
      {
        async requireByAiTaskId() { return task; },
        async updateStatus(_id, status) { statuses.push(status); },
        async updateResult() { throw new Error('processResult should be skipped'); },
      },
      {
        async processResult() { throw new Error('processResult should be skipped'); },
      },
      {
        async add(_name, data) { queueJobs.push(data); return null; },
      },
    );

    await processor.process({ ai_task_id: 'task-1' });

    expect(statuses).toEqual(['callback_pending']);
    expect(queueJobs).toMatchObject([{ ai_task_id: 'task-1' }]);
  });
});
