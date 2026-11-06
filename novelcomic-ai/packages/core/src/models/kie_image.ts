import type { CoreModelEntity, JsonObject } from '../types.js';
import { KieProviderClient, resolveKieWebhookUrl, type KieSubmitInput } from '../provider/kie_client.js';
import { normalizeKieResult } from '../provider/kie_result.js';

export const KIE_IMAGE_MODEL_ID = 'kie-image-v1';
export const KIE_IMAGE_PROVIDER_MODEL_ID = 'z-image';
export const KIE_CREATE_TASK_ENDPOINT = '/jobs/createTask';
export const KIE_RECORD_INFO_ENDPOINT = '/jobs/recordInfo';

export const KieImageOptionsSchema: JsonObject = {
  type: 'object',
  required: ['prompt'],
  additionalProperties: true,
  properties: {
    prompt: { type: 'string', minLength: 1 },
    negative_prompt: { type: 'string' },
    aspect_ratio: { type: 'string' },
    size: { type: 'string' },
    seed: { type: 'number' },
  },
};

export const KieImageModel: CoreModelEntity = {
  id: KIE_IMAGE_MODEL_ID,
  aliases: ['kie-image', 'z-image'],
  displayName: 'KIE Image',
  robin_calls: [
    {
      provider: 'kie',
      model_id: KIE_IMAGE_PROVIDER_MODEL_ID,
      options_schema: KieImageOptionsSchema,
      result_mode: 'webhook',
      submit(input) {
        const submitInput: KieSubmitInput = {
          endpoint: KIE_CREATE_TASK_ENDPOINT,
          model_id: KIE_IMAGE_PROVIDER_MODEL_ID,
          options: input.options,
        };
        const callbackUrl = resolveKieWebhookUrl(input.webhook_url);
        if (callbackUrl) {
          submitInput.webhook_url = callbackUrl;
        }
        return createKieClient().submit(submitInput);
      },
      getResult(input) {
        return createKieClient().getResult({
          endpoint: KIE_RECORD_INFO_ENDPOINT,
          request_id: input.request_id,
        });
      },
      normalizeResult: normalizeKieResult,
    },
  ],
};

function createKieClient(): KieProviderClient {
  const apiKey = process.env.KIE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('KIE_API_KEY is required to submit KIE image tasks');
  }

  const baseUrl = process.env.KIE_BASE_URL?.trim();
  return new KieProviderClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  });
}
