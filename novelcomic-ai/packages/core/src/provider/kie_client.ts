import type { CoreSubmitResult, JsonObject, JsonValue } from '../types.js';

export const DEFAULT_KIE_BASE_URL = 'https://api.kie.ai/api/v1';

export type KieResponseBody = JsonValue;

export interface KieClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface KieSubmitInput {
  model_id: string;
  endpoint: string;
  options: JsonObject;
  webhook_url?: string;
}

export function resolveKieWebhookUrl(explicitOrTaskWebhookUrl?: string): string | undefined {
  const configuredBaseUrl = (
    process.env.PROVIDER_WEBHOOK_BASE_URL?.trim() ||
    process.env.PUBLIC_API_URL?.trim() ||
    ''
  ).replace(/\/+$/, '');
  if (configuredBaseUrl) {
    return `${configuredBaseUrl}/v1/provider-webhooks/kie`;
  }
  if (explicitOrTaskWebhookUrl && /\/v1\/provider-webhooks\/kie\b/i.test(explicitOrTaskWebhookUrl)) {
    return explicitOrTaskWebhookUrl;
  }
  return undefined;
}

export interface KieGetResultInput {
  endpoint: string;
  request_id: string;
}

export interface KieCancelInput {
  endpoint: string;
  request_id: string;
}

export class KieProviderClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: KieClientConfig) {
    if (!config.apiKey.trim()) {
      throw new Error('KIE API key is required');
    }

    this.apiKey = config.apiKey;
    this.baseUrl = trimTrailingSlash(config.baseUrl ?? DEFAULT_KIE_BASE_URL);
    this.fetchImpl = config.fetch ?? fetch;
  }

  async submit(input: KieSubmitInput): Promise<CoreSubmitResult> {
    const callbackUrl = resolveKieWebhookUrl(input.webhook_url);
    const body = await this.request('POST', input.endpoint, {
      model: input.model_id,
      input: input.options,
      ...(callbackUrl ? { callBackUrl: callbackUrl } : {}),
    });
    const requestId = readFirstString(body, [
      'request_id',
      'requestId',
      'task_id',
      'taskId',
      'id',
      'data.request_id',
      'data.requestId',
      'data.task_id',
      'data.taskId',
      'data.id',
    ]);

    return {
      provider: 'kie',
      model_id: input.model_id,
      ...(requestId ? { request_id: requestId } : {}),
      status: requestId ? 'submitted' : 'succeeded',
      raw: body,
    };
  }

  async getResult(input: KieGetResultInput): Promise<KieResponseBody> {
    const search = new URLSearchParams({ taskId: input.request_id });
    return this.request('GET', `${input.endpoint}?${search.toString()}`);
  }

  async cancel(input: KieCancelInput): Promise<KieResponseBody> {
    return this.request('POST', input.endpoint, { id: input.request_id });
  }

  private async request(method: 'GET' | 'POST', endpoint: string, body?: JsonObject): Promise<KieResponseBody> {
    const response = await this.fetchImpl(toUrl(this.baseUrl, endpoint), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      throw new KieProviderRequestError(response.status, response.statusText, responseBody);
    }

    return responseBody;
  }
}

export class KieProviderRequestError extends Error {
  readonly code = 'KIE_PROVIDER_REQUEST_FAILED';

  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: KieResponseBody,
  ) {
    super(`KIE request failed with HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.name = 'KieProviderRequestError';
  }
}

async function readJsonResponse(response: Response): Promise<KieResponseBody> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as KieResponseBody;
  } catch {
    return { raw: text };
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function toUrl(baseUrl: string, endpoint: string): string {
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${baseUrl}${normalizedEndpoint}`;
}

function readFirstString(body: KieResponseBody, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    const value = readPath(body, path.split('.'));
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
