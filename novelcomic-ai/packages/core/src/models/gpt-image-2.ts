import type { CoreModelEntity, CoreProviderCall, CoreProviderResult, CoreSubmitResult, JsonObject } from '../types.js';
import {
  BAIDU_GPT_IMAGE_MODEL,
  BaiduGptImageClient,
  type BaiduGptImageTaskType,
} from '../provider/baidu_gpt_image_client.js';
import { KieProviderClient, resolveKieWebhookUrl } from '../provider/kie_client.js';
import { normalizeKieResult } from '../provider/kie_result.js';
import { KIE_CREATE_TASK_ENDPOINT, KIE_RECORD_INFO_ENDPOINT } from './kie_image.js';

export const GPT_IMAGE_2_TEXT_MODEL_ID = 'opencreator/text-to-image/gpt-image-2';
export const GPT_IMAGE_2_EDIT_MODEL_ID = 'opencreator/image-to-image/gpt-image-2-edit';

const textOptionsSchema: JsonObject = {
  type: 'object',
  required: ['prompt'],
  additionalProperties: true,
  properties: {
    prompt: { type: 'string', minLength: 1 },
    quality: { type: 'string', enum: ['low', 'medium', 'high'] },
    size: { type: 'string' },
    image_size: { type: 'string' },
    aspect_ratio: { type: 'string' },
  },
};

const editOptionsSchema: JsonObject = {
  type: 'object',
  required: ['prompt'],
  additionalProperties: true,
  properties: {
    ...((textOptionsSchema.properties ?? {}) as JsonObject),
    image_url: { type: 'string', minLength: 1 },
  },
};

function createCall(taskType: BaiduGptImageTaskType) {
  return {
    provider: 'baidu' as const,
    model_id: BAIDU_GPT_IMAGE_MODEL,
    options_schema: taskType === 'edit' ? editOptionsSchema : textOptionsSchema,
    result_mode: 'polling' as const,
    submit(input: { options: JsonObject }) {
      return createClient().submit({ taskType, options: input.options });
    },
    normalizeResult(raw: unknown): CoreProviderResult {
      if (raw && typeof raw === 'object' && 'status' in raw) {
        return raw as CoreProviderResult;
      }
      return { status: 'processing', raw };
    },
  };
}

export const GptImage2TextToImageModel: CoreModelEntity = {
  id: GPT_IMAGE_2_TEXT_MODEL_ID,
  aliases: ['openai/gpt-image-2'],
  displayName: 'GPT Image 2',
  robin_calls: [
    createCall('generate'),
    createFallbackProviderCall('tencent', 'gpt-image-2', 'generate'),
    createFallbackProviderCall('openai', 'gpt-image-2', 'generate'),
    createFallbackProviderCall('fal', 'fal-ai/gpt-image-2', 'generate'),
    createKieGptImageCall('gpt-image-2', 'generate'),
  ],
};

export const GptImage2EditImageToImageModel: CoreModelEntity = {
  id: GPT_IMAGE_2_EDIT_MODEL_ID,
  aliases: ['openai/gpt-image-2/edit'],
  displayName: 'GPT Image 2 Edit',
  robin_calls: [
    createCall('edit'),
    createFallbackProviderCall('tencent', 'gpt-image-2-edit', 'edit'),
    createFallbackProviderCall('openai', 'gpt-image-2', 'edit'),
    createFallbackProviderCall('fal', 'fal-ai/gpt-image-2/edit', 'edit'),
    createKieGptImageCall('gpt-image-2-edit', 'edit'),
  ],
};

function createFallbackProviderCall(
  provider: 'tencent' | 'openai' | 'fal',
  providerModelId: string,
  taskType: BaiduGptImageTaskType,
): CoreProviderCall {
  return {
    provider,
    model_id: providerModelId,
    options_schema: taskType === 'edit' ? editOptionsSchema : textOptionsSchema,
    result_mode: provider === 'openai' ? 'sync' : 'webhook',
    async submit(input): Promise<CoreSubmitResult> {
      if (provider === 'openai') {
        const apiKey = process.env.OPENAI_API_KEY?.trim();
        if (!apiKey) {
          throw new Error('OPENAI_API_KEY is required to submit GPT Image 2 tasks');
        }
        const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const response = await fetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: providerModelId,
            prompt: input.options.prompt,
            n: 1,
            size: input.options.size ?? '1024x1024',
            ...(input.options.quality ? { quality: input.options.quality } : {}),
          }),
        });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          throw new Error(`OpenAI GPT Image 2 request failed with HTTP ${response.status}`);
        }
        const first = Array.isArray(body.data) ? (body.data[0] as Record<string, unknown> | undefined) : undefined;
        const url = typeof first?.url === 'string'
          ? first.url
          : typeof first?.b64_json === 'string'
            ? `data:image/png;base64,${first.b64_json}`
            : undefined;
        return {
          provider: 'openai',
          model_id: providerModelId,
          status: 'succeeded',
          result_mode: 'sync',
          ...(url
            ? {
                result: {
                  status: 'succeeded',
                  outputs: {
                    output: url,
                    url,
                    artifacts: [{ type: 'image', url }],
                  },
                },
              }
            : {}),
          raw: body,
        };
      }
      throw new Error(`${provider.toUpperCase()} credentials are required to submit ${providerModelId}`);
    },
    normalizeResult(raw: unknown): CoreProviderResult {
      if (raw && typeof raw === 'object' && 'status' in raw) {
        return raw as CoreProviderResult;
      }
      return { status: 'processing', raw };
    },
  };
}

function createKieGptImageCall(providerModelId: string, taskType: BaiduGptImageTaskType): CoreProviderCall {
  return {
    provider: 'kie',
    model_id: providerModelId,
    options_schema: taskType === 'edit' ? editOptionsSchema : textOptionsSchema,
    result_mode: 'webhook',
    submit(input) {
      const apiKey = process.env.KIE_API_KEY?.trim();
      if (!apiKey) {
        throw new Error('KIE_API_KEY is required to submit KIE GPT Image 2 tasks');
      }
      const baseUrl = process.env.KIE_BASE_URL?.trim();
      const client = new KieProviderClient({
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      });
      const callbackUrl = resolveKieWebhookUrl(input.webhook_url);
      return client.submit({
        endpoint: KIE_CREATE_TASK_ENDPOINT,
        model_id: providerModelId,
        options: input.options,
        ...(callbackUrl ? { webhook_url: callbackUrl } : {}),
      });
    },
    getResult(input) {
      const apiKey = process.env.KIE_API_KEY?.trim();
      if (!apiKey) {
        throw new Error('KIE_API_KEY is required to poll KIE GPT Image 2 tasks');
      }
      const baseUrl = process.env.KIE_BASE_URL?.trim();
      const client = new KieProviderClient({
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      });
      return client.getResult({
        endpoint: KIE_RECORD_INFO_ENDPOINT,
        request_id: input.request_id,
      });
    },
    normalizeResult: normalizeKieResult,
  };
}

function createClient(): BaiduGptImageClient {
  const apiKey = process.env.BAIDU_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('BAIDU_API_KEY is required to submit GPT Image 2 tasks');
  }
  const baseUrl = process.env.BAIDU_BASE_URL?.trim();
  return new BaiduGptImageClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  });
}
