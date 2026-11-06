import { describe, expect, it } from 'vitest';
import { createArtifactUploader, DefaultArtifactStore, PassThroughArtifactStore } from './index.js';
import type { AppConfig } from '@novelcomic/config';

const baseConfig = {
  NODE_ENV: 'test',
  API_HOST: '0.0.0.0',
  API_PORT: 5151,
  CORS_ORIGIN: 'http://localhost:3000',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DB: 'novelcomic',
  REDIS_URL: 'redis://127.0.0.1:6379',
  LOG_LEVEL: 'silent',
  AUTH_KEY: 'test-auth-key',
  CONSUMER_WEBHOOK_SECRET: '',
  UPLOAD_DIR: 'uploads',
  COS_PRESIGN_SECRET: 'secret',
  ARTIFACT_STORAGE_PROVIDER: 'pass_through',
  KIE_BASE_URL: 'https://api.kie.ai/api/v1',
  ENABLE_BULL_BOARD: false,
  CONFIG_LOADER_ENABLED: false,
  MODEL_CALL_FEISHU_ENABLED: false,
  MODEL_CALL_FEISHU_TIMEOUT_MS: 5_000,
  MODEL_CALL_FEISHU_ENVIRONMENT: 'test',
  ALERT_FEISHU_ENABLED: false,
  ALERT_FEISHU_TIMEOUT_MS: 5_000,
  REASON_MAPPING_FEISHU_TIMEOUT_MS: 10_000,
} satisfies AppConfig;

describe('artifact storage', () => {
  it('keeps remote URLs unchanged for pass_through uploads', async () => {
    const uploader = createArtifactUploader(baseConfig);

    await expect(uploader.uploadRemoteUrl('https://vendor.test/out.png')).resolves.toBe('https://vendor.test/out.png');
  });

  it('only annotates artifact metadata in PassThroughArtifactStore', async () => {
    const store = new PassThroughArtifactStore({ ARTIFACT_BASE_URL: 'https://artifacts.test' });

    await expect(store.processResult({ url: 'https://vendor.test/out.png', metadata: { model: 'seedance' } })).resolves.toEqual({
      url: 'https://vendor.test/out.png',
      metadata: {
        model: 'seedance',
        artifact_base_url: 'https://artifacts.test',
      },
    });
  });

  it('processes normalized artifacts while preserving the result shape', async () => {
    const uploadedUrls: string[] = [];
    const store = new DefaultArtifactStore({
      async uploadRemoteUrl(remoteUrl) {
        uploadedUrls.push(remoteUrl);
        return 'https://cdn.test/stable/out.png';
      },
    });

    await expect(store.processResult({
      output: 'done',
      artifacts: [
        { type: 'image', url: 'https://vendor.test/out.png', mime_type: 'image/png' },
      ],
      metadata: { model: 'kie' },
    })).resolves.toEqual({
      output: 'done',
      artifacts: [
        { type: 'image', url: 'https://cdn.test/stable/out.png', mime_type: 'image/png' },
      ],
      metadata: { model: 'kie' },
    });
    expect(uploadedUrls).toEqual(['https://vendor.test/out.png']);
  });

  it('downloads bytes and performs a signed PUT for COS artifact uploads', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; bodyLen: number }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body as Uint8Array | undefined;
      calls.push({ url, method, headers, bodyLen: body?.byteLength ?? 0 });
      return new Response('', { status: 200 });
    };

    const uploader = createArtifactUploader(
      {
        ...baseConfig,
        ARTIFACT_STORAGE_PROVIDER: 'cos',
        COS_SECRET_ID: 'ak-test',
        COS_SECRET_KEY: 'sk-test',
        COS_REGION: 'ap-shanghai',
        COS_BUCKET: 'comic-1250000000',
        COS_CDN_DOMAIN: 'https://cdn.novelcomic.test',
      },
      mockFetch,
    );

    const cdnUrl = await uploader.uploadRemoteUrl('https://vendor.test/panel.png');
    expect(cdnUrl).toMatch(/^https:\/\/cdn\.novelcomic\.test\/images\/\d{4}\/\d{2}\/result-.*\.png$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toContain('comic-1250000000.cos.ap-shanghai.myqcloud.com/images/');
    expect(calls[0]?.headers.Authorization).toContain('q-sign-algorithm=sha1');
    expect(calls[0]?.bodyLen).toBe(4);
  });
});
