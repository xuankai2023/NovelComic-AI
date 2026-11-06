import type { CoreProviderResult, CoreSubmitResult, JsonObject } from '../types.js';

export const BAIDU_GPT_IMAGE_MODEL = 'gpt-image-2';
export const BAIDU_GPT_IMAGE_GENERATE_PATH = '/v3/aigc/v1/images/generations';
export const BAIDU_GPT_IMAGE_EDIT_PATH = '/v3/aigc/v1/images/edits';
export const DEFAULT_BAIDU_BASE_URL = 'https://vod.bj.baidubce.com';

export type BaiduGptImageTaskType = 'generate' | 'edit';

export interface BaiduGptImageClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class BaiduGptImageClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: BaiduGptImageClientConfig) {
    if (!config.apiKey.trim()) {
      throw new Error('BAIDU_API_KEY is required for Baidu GPT Image');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BAIDU_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
  }

  async submit(input: {
    taskType: BaiduGptImageTaskType;
    options: JsonObject;
  }): Promise<CoreSubmitResult> {
    const editing = input.taskType === 'edit';
    const path = editing ? BAIDU_GPT_IMAGE_EDIT_PATH : BAIDU_GPT_IMAGE_GENERATE_PATH;
    const body = buildBaiduGptImageRequestBody(input.options);
    const response = editing
      ? await this.submitEdit(`${this.baseUrl}${path}`, body, input.options)
      : await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

    if (!response.ok) {
      throw new Error(`Baidu GPT Image API error (${response.status})`);
    }

    const payload = (await response.json()) as JsonObject;
    const images = extractBaiduGptImageDataUrls(payload);
    if (images.length === 0) {
      throw new Error('No base64 image data in Baidu GPT Image response');
    }

    const result: CoreProviderResult = {
      status: 'succeeded',
      outputs: { images },
      raw: payload,
    };
    return {
      provider: 'baidu',
      model_id: BAIDU_GPT_IMAGE_MODEL,
      provider_request_id: `baidu-gpt-image-${Date.now()}`,
      status: 'succeeded',
      provider_status: 'COMPLETED',
      result_mode: 'polling',
      raw: payload,
      result,
    };
  }

  private async submitEdit(url: string, body: JsonObject, options: JsonObject): Promise<Response> {
    const imageUrl = firstString(options, ['image_url']);
    const imageUrls = Array.isArray(options.image_urls)
      ? options.image_urls.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [];
    const sources = imageUrl ? [imageUrl, ...imageUrls] : imageUrls;
    if (sources.length === 0) {
      throw new Error('image_urls or image_url is required');
    }

    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      form.append(key, String(value));
    }
    for (const [index, source] of sources.entries()) {
      const downloaded = await this.fetchImpl(source);
      if (!downloaded.ok) {
        throw new Error(`Failed to download image for Baidu GPT Image edit: ${source}`);
      }
      const blob = await downloaded.blob();
      form.append('image[]', new File([blob], `image-${index + 1}.png`, { type: blob.type || 'image/png' }));
    }
    return this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
  }
}

export function buildBaiduGptImageRequestBody(input: JsonObject): JsonObject {
  return {
    model: BAIDU_GPT_IMAGE_MODEL,
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    n: 1,
    size: baiduSize(input),
    quality: input.quality === 'low' || input.quality === 'high' ? input.quality : 'medium',
  };
}

export function extractBaiduGptImageDataUrls(body: JsonObject): string[] {
  if (!Array.isArray(body.data)) {
    return [];
  }
  const urls: string[] = [];
  for (const item of body.data) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const encoded = item.b64_json;
      if (typeof encoded === 'string' && encoded.length > 0) {
        urls.push(`data:image/png;base64,${encoded}`);
      }
    }
  }
  return urls;
}

export function baiduSize(input: JsonObject): string {
  const size = firstString(input, ['size', 'image_size', 'imageSize']);
  const mapped: Record<string, string> = {
    '1024x1024': '1024x1024',
    '1024x1536': '1024x1536',
    '1536x1024': '1536x1024',
    '2560x1440': '2560x1440',
    portrait_4_3: '1024x1536',
    portrait_16_9: '1024x1536',
    landscape_4_3: '1536x1024',
    landscape_16_9: '1536x1024',
    square: '1024x1024',
    square_hd: '1024x1024',
  };
  if (size && mapped[size]) {
    return mapped[size];
  }
  const ratio = firstString(input, ['aspect_ratio', 'aspectRatio']);
  if (ratio === '9:16' || ratio === '3:4') {
    return '1024x1536';
  }
  if (ratio === '1:1') {
    return '1024x1024';
  }
  return '1536x1024';
}

function firstString(input: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
