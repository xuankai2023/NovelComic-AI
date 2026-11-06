import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireCoreModel, submitCoreTask } from '../model-runtime.js';
import { resolveKieWebhookUrl } from '../provider/kie_client.js';
import { GPT_IMAGE_2_TEXT_MODEL_ID } from './gpt-image-2.js';
import { MidjourneyV81TextToImageModel } from './midjourney.js';

describe('GPT Image 2', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BAIDU_API_KEY;
    delete process.env.BAIDU_BASE_URL;
    delete process.env.PROVIDER_WEBHOOK_BASE_URL;
    delete process.env.PUBLIC_API_URL;
  });

  it('registers the OpenCreator text and edit ids', () => {
    expect(requireCoreModel('openai/gpt-image-2').id).toBe('opencreator/text-to-image/gpt-image-2');
    expect(requireCoreModel('openai/gpt-image-2/edit').id).toBe('opencreator/image-to-image/gpt-image-2-edit');
    expect(requireCoreModel(GPT_IMAGE_2_TEXT_MODEL_ID).robin_calls?.[0]).toMatchObject({
      provider: 'baidu',
      model_id: 'gpt-image-2',
    });
    expect(requireCoreModel(GPT_IMAGE_2_TEXT_MODEL_ID).robin_calls?.map((c) => c.provider)).toEqual([
      'baidu',
      'tencent',
      'openai',
      'fal',
      'kie',
    ]);
    expect(MidjourneyV81TextToImageModel.robin_calls?.[0]?.result_mode).toBe('polling');
  });

  it('resolves KIE provider webhook URL to /v1/provider-webhooks/kie instead of consumer callback URL', () => {
    expect(resolveKieWebhookUrl('https://consumer.test/callbacks/models/opencreator_ai')).toBeUndefined();
    process.env.PROVIDER_WEBHOOK_BASE_URL = 'https://ai-gateway.test/';
    expect(resolveKieWebhookUrl('https://consumer.test/callbacks/models/opencreator_ai')).toBe(
      'https://ai-gateway.test/v1/provider-webhooks/kie',
    );
  });

  it('submits a portrait generation to Baidu', async () => {
    process.env.BAIDU_API_KEY = 'test-baidu-api-key';
    process.env.BAIDU_BASE_URL = 'https://baidu.test';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'YmFpZHU=' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await submitCoreTask({
      ai_task_id: 'task-1',
      model_id: 'openai/gpt-image-2',
      options: { prompt: 'a comic panel', quality: 'low', aspect_ratio: '9:16' },
      webhook_url: 'https://example.test/hook',
    });

    expect(result).toMatchObject({
      provider: 'baidu',
      model_id: 'gpt-image-2',
      status: 'succeeded',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://baidu.test/v3/aigc/v1/images/generations');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-baidu-api-key');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-image-2',
      prompt: 'a comic panel',
      n: 1,
      size: '1024x1536',
      quality: 'low',
    });
  });
});
