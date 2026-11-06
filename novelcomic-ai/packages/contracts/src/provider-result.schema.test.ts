import { describe, expect, it } from 'vitest';
import {
  NormalizedErrorSchema,
  NormalizedTaskResultSchema,
  ParsedProviderResultSchema,
  ProviderResultSchema,
} from './provider-result.schema.js';

describe('provider result schemas', () => {
  it('accepts a normalized succeeded provider result', () => {
    expect(
      ProviderResultSchema.parse({
        ai_task_id: 'task-1',
        status: 'succeeded',
        provider: 'kie',
        model_id: 'novelcomic-image',
        provider_model_id: 'kie-image-v1',
        provider_request_id: 'provider-request-1',
        provider_status: 'success',
        result: {
          output: 'generated image',
          data: { prompt: 'hello' },
          artifacts: [
            {
              type: 'image',
              url: 'https://cdn.example.com/image.png',
              mime_type: 'image/png',
              width: 1024,
              height: 1024,
            },
          ],
          metadata: { seed: 42 },
        },
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          total_tokens: 15,
        },
        raw_summary: { request_id: 'provider-request-1' },
      }),
    ).toMatchObject({
      status: 'succeeded',
      result: {
        artifacts: [{ type: 'image' }],
      },
    });
  });

  it('accepts a waiting parsed provider result without task identity', () => {
    expect(
      ParsedProviderResultSchema.parse({
        status: 'waiting_provider',
        provider: 'kie',
        provider_model_id: 'kie-image-v1',
        provider_request_id: 'provider-request-1',
        provider_status: 'processing',
      }),
    ).toMatchObject({
      status: 'waiting_provider',
      provider: 'kie',
    });
  });

  it('keeps normalized result and error payloads strict', () => {
    expect(() => NormalizedTaskResultSchema.parse({ output: 'ok', extra: true })).toThrow();
    expect(() => NormalizedErrorSchema.parse({ code: 'failed', message: 'failed' })).toThrow();
  });
});
