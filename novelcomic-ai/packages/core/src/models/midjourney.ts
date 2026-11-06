import type { CoreModelEntity, CoreProviderCall, CoreProviderResult, CoreSubmitResult, JsonObject, JsonValue } from '../types.js';

export const YOUCHUAN_DEFAULT_BASE_URL = 'https://ali.youchuan.cn';
export const YOUCHUAN_DIFFUSION_PATH = '/v1/tob/diffusion';

const promptOptions: JsonObject = {
  type: 'object',
  required: ['prompt'],
  additionalProperties: true,
  properties: {
    prompt: { type: 'string', minLength: 1 },
    aspect_ratio: { type: 'string' },
    image_weight: { type: 'number' },
    style_weight: { type: 'number' },
    style_version: { type: 'number' },
    image_url: { type: 'string' },
    reference_image_url: { type: 'string' },
    style_reference_url: { type: 'string' },
  },
};

export function sanitizeMidjourneyPromptText(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const text = prompt
    .replace(/\\([\[\]-])/g, '$1')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\[(?!https?:\/\/)[^\]]+\]/g, ' ')
    .replace(
      /--(?:orefUpload|oref|ow|cref|cw|ar|v|stylize|style|raw|iw|sref|sw|sv|chaos|seed|no|tile|quality|q|s)(?:\s+[^\s-][^\s]*)*/gi,
      ' ',
    )
    .replace(/\b(?:Upload\s+\d+|Image Input)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : undefined;
}

export function toYouchuanImagePromptUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.search) return url;
    if (/imageMogr2|imageView2|imageSlim/i.test(parsed.search)) {
      parsed.search = '';
      return parsed.toString();
    }
    return url;
  } catch {
    const q = url.indexOf('?');
    if (q > 0 && /imageMogr2|imageView2|imageSlim/i.test(url.slice(q))) {
      return url.slice(0, q);
    }
    return url;
  }
}

export function buildYouchuanMidjourneyPrompt(opts: Record<string, unknown>, defaultVersion = '8.1'): string {
  const imageUrls = [
    ...(Array.isArray(opts.image_urls) ? opts.image_urls : []),
    ...(Array.isArray(opts.reference_image_urls) ? opts.reference_image_urls : []),
    opts.image_url,
    opts.reference_image_url,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(toYouchuanImagePromptUrl);

  const prompt = sanitizeMidjourneyPromptText(typeof opts.prompt === 'string' ? opts.prompt : undefined);
  const flags: string[] = [];
  if (typeof opts.aspect_ratio === 'string' && opts.aspect_ratio.trim()) {
    flags.push(`--ar ${opts.aspect_ratio.trim()}`);
  }
  if (typeof opts.image_weight === 'number' && Number.isFinite(opts.image_weight)) {
    flags.push(`--iw ${opts.image_weight}`);
  }
  const srefUrls = [
    ...(Array.isArray(opts.style_reference_urls) ? opts.style_reference_urls : []),
    opts.style_reference_url,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (srefUrls.length > 0) {
    flags.push(`--sref ${srefUrls.join(' ')}`);
  }
  if (typeof opts.style_weight === 'number' && Number.isFinite(opts.style_weight)) {
    flags.push(`--sw ${opts.style_weight}`);
  }
  if (typeof opts.style_version === 'number' && Number.isFinite(opts.style_version)) {
    flags.push(`--sv ${opts.style_version}`);
  } else if (srefUrls.length > 0 && defaultVersion === '8.1') {
    flags.push('--sv 6');
  }
  const version = typeof opts.model_version === 'string' && opts.model_version.trim()
    ? opts.model_version.trim()
    : defaultVersion;
  flags.push(`--v ${version}`);
  return [...imageUrls, ...(prompt ? [prompt] : []), ...flags].join(' ').trim();
}

function getYouchuanCredentials(modelId: string): { appId: string; secretKey: string; baseUrl: string } {
  const appId = process.env.YOUCHUAN_APP_ID?.trim();
  const secretKey = process.env.YOUCHUAN_SECRET_KEY?.trim();
  if (!appId || !secretKey) {
    throw new Error(`Youchuan credentials are required to submit ${modelId}`);
  }
  const baseUrl = (process.env.YOUCHUAN_BASE_URL?.trim() || YOUCHUAN_DEFAULT_BASE_URL).replace(/\/+$/, '');
  return { appId, secretKey, baseUrl };
}

function extractYouchuanJobId(body: Record<string, unknown>): string {
  if (typeof body.id === 'string' && body.id.length > 0) return body.id;
  if (typeof body.jobId === 'string' && body.jobId.length > 0) return body.jobId;
  if (typeof body.cost === 'object' && body.cost !== null) {
    const nested = (body.cost as Record<string, unknown>).jobId;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return '';
}

function extractYouchuanUrls(raw: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const key of ['urls', 'images', 'image_urls', 'result_urls']) {
    const val = raw[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.trim()) urls.push(item.trim());
        else if (typeof item === 'object' && item !== null && typeof (item as { url?: unknown }).url === 'string') {
          urls.push(((item as { url: string }).url).trim());
        }
      }
    }
  }
  for (const key of ['url', 'image_url', 'imageUrl']) {
    const val = raw[key];
    if (typeof val === 'string' && val.trim()) urls.push(val.trim());
  }
  return [...new Set(urls)];
}

export function normalizeYouchuanResult(raw: unknown): CoreProviderResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'processing', raw };
  }
  const body = raw as Record<string, unknown>;
  const comment = typeof body.comment === 'string' ? body.comment : '';
  const statusCode = typeof body.status === 'number' ? body.status : undefined;

  if (comment === 'JobStatusSuccess' || comment === '成功' || statusCode === 2 || body.status === 'succeeded') {
    const urls = extractYouchuanUrls(body);
    const artifacts = urls.map((url) => ({ type: 'image', url })) as unknown as JsonValue;
    return {
      status: 'succeeded',
      outputs: {
        ...(urls[0] ? { output: urls[0], url: urls[0] } : {}),
        images: urls,
        artifacts,
      },
      raw,
    };
  }

  if (
    comment === 'JobStatusFail' ||
    comment === 'JobStatusError' ||
    comment === 'JobStatusReject' ||
    comment === 'JobStatusTextReject' ||
    comment === 'JobStatusBadPrompt' ||
    comment === 'JobStatusTimeout' ||
    (typeof statusCode === 'number' && statusCode >= 3) ||
    body.status === 'failed'
  ) {
    const message =
      (typeof body.reason === 'string' && body.reason) ||
      (typeof body.message === 'string' && body.message) ||
      comment ||
      'Youchuan job failed';
    return {
      status: 'failed',
      error: {
        code: comment || 'youchuan_job_failed',
        message,
        retryable: comment === 'JobStatusMaxConcurrentLimited',
      },
      raw,
    };
  }

  return { status: 'processing', raw };
}

function youchuanCall(modelId: string, defaultVersion = '8.1'): CoreProviderCall {
  return {
    provider: 'youchuan',
    model_id: modelId,
    options_schema: promptOptions,
    result_mode: 'polling',
    async submit(input): Promise<CoreSubmitResult> {
      const { appId, secretKey, baseUrl } = getYouchuanCredentials(modelId);
      const text = buildYouchuanMidjourneyPrompt(input.options, defaultVersion);
      const response = await fetch(`${baseUrl}${YOUCHUAN_DIFFUSION_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-youchuan-app': appId,
          'x-youchuan-secret': secretKey,
        },
        body: JSON.stringify({ text }),
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`Youchuan submit HTTP ${response.status}: ${String(json.message ?? json.reason ?? response.statusText)}`);
      }
      const jobId = extractYouchuanJobId(json);
      if (!jobId) {
        throw new Error('No job id returned from Youchuan');
      }
      return {
        provider: 'youchuan',
        model_id: modelId,
        request_id: jobId,
        provider_request_id: jobId,
        status: 'submitted',
        result_mode: 'polling',
        raw: json,
      };
    },
    async getResult(input) {
      const { appId, secretKey, baseUrl } = getYouchuanCredentials(modelId);
      const response = await fetch(`${baseUrl}/v1/tob/job/${encodeURIComponent(input.request_id)}`, {
        method: 'GET',
        headers: {
          'x-youchuan-app': appId,
          'x-youchuan-secret': secretKey,
        },
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`Youchuan poll HTTP ${response.status}: ${String(json.message ?? json.reason ?? response.statusText)}`);
      }
      return json;
    },
    normalizeResult: normalizeYouchuanResult,
  };
}

export const MidjourneyV81TextToImageModel: CoreModelEntity = {
  id: 'opencreator/text-to-image/midjourney-v8-1',
  displayName: 'Midjourney V8.1',
  aliases: ['opencreator/text-to-image/midjourney-v8'],
  robin_calls: [youchuanCall('midjourney-v8-1-text', '8.1')],
};

export const MidjourneyV81ImageToImageModel: CoreModelEntity = {
  id: 'opencreator/image-to-image/midjourney-v8-1',
  displayName: 'Midjourney V8.1',
  aliases: ['opencreator/image-to-image/midjourney-v8'],
  robin_calls: [youchuanCall('midjourney-v8-1-image', '8.1')],
};

export const MidjourneyV82TextToImageModel: CoreModelEntity = {
  id: 'opencreator/text-to-image/midjourney-v8-2',
  displayName: 'Midjourney V8.2',
  robin_calls: [youchuanCall('midjourney-v8-2-text', '8.2')],
};

export const MidjourneyV82ImageToImageModel: CoreModelEntity = {
  id: 'opencreator/image-to-image/midjourney-v8-2',
  displayName: 'Midjourney V8.2',
  robin_calls: [youchuanCall('midjourney-v8-2-image', '8.2')],
};
