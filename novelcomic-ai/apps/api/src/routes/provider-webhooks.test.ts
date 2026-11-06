import type { ProviderWebhookHeaders, ProviderWebhookHandleResult } from '@novelcomic/runtime';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { registerAuthKeyHook } from '../plugins/auth-key.js';
import { registerProviderWebhookRoutes } from './provider-webhooks.js';

describe('registerProviderWebhookRoutes', () => {
  it('passes provider, body, and headers to the webhook service', async () => {
    const calls: Array<{ provider: string; body: unknown; headers: ProviderWebhookHeaders }> = [];
    const app = Fastify({ logger: false });

    await registerProviderWebhookRoutes(app as unknown as Parameters<typeof registerProviderWebhookRoutes>[0], {
      service: {
        async handleWebhook(provider, body, headers): Promise<ProviderWebhookHandleResult> {
          calls.push({ provider, body, headers });
          return { status: 'accepted', provider, provider_status: 'submitted' };
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/provider-webhooks/Provider-A',
      headers: {
        'x-provider-signature': 'sig-1',
        'x-provider-event': 'event-1',
      },
      payload: {
        request_id: 'request-1',
        status: 'succeeded',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      code: 200,
      msg: 'accepted',
      data: {
        status: 'accepted',
        provider: 'provider-a',
        provider_status: 'submitted',
      },
    });
    expect(calls).toEqual([
      {
        provider: 'provider-a',
        body: {
          request_id: 'request-1',
          status: 'succeeded',
        },
        headers: expect.objectContaining({
          'x-provider-signature': 'sig-1',
          'x-provider-event': 'event-1',
          'content-type': 'application/json',
        }) as ProviderWebhookHeaders,
      },
    ]);

    await app.close();
  });

  it('accepts a provider webhook without auth_key, rejects a bad Tencent signature, and echoes MiniMax challenge', async () => {
    const calls: Array<{ provider: string; headers: ProviderWebhookHeaders }> = [];
    const app = Fastify({ logger: false });
    const signKey = 'tencent-sign-key';
    registerAuthKeyHook(app, { security: { authKey: 'task-auth-key' } });
    await registerProviderWebhookRoutes(app as unknown as Parameters<typeof registerProviderWebhookRoutes>[0], {
      tencentSignKey: signKey,
      service: {
        async handleWebhook(provider, _body, headers): Promise<ProviderWebhookHandleResult> {
          calls.push({ provider, headers });
          return { status: 'accepted', provider, provider_status: 'submitted' };
        },
      },
    });

    const open = await app.inject({
      method: 'POST',
      url: '/v1/provider-webhooks/provider-a',
      payload: { request_id: 'request-1', status: 'succeeded' },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/provider-webhooks/tencent',
      payload: { Sign: 'bad', T: String(Math.floor(Date.now() / 1000) + 60) },
    });
    const now = Math.floor(Date.now() / 1000) + 120;
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/provider-webhooks/Tencent',
      payload: {
        Sign: createHash('md5').update(`${signKey}${now}`, 'utf8').digest('hex'),
        T: now,
        event_id: 'tencent-event-1',
      },
    });
    const challenge = await app.inject({
      method: 'POST',
      url: '/v1/provider-webhooks/MiniMax',
      payload: { challenge: '426799442911302' },
    });

    expect(open.statusCode).toBe(202);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: 403, msg: 'invalid_signature' });
    expect(accepted.statusCode).toBe(202);
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toEqual({ challenge: '426799442911302' });
    expect(calls.map((call) => call.provider)).toEqual(['provider-a', 'tencent']);
    expect(calls[0]?.headers['x-oc-signature-verified']).toBeUndefined();
    expect(calls[1]?.headers['x-oc-signature-verified']).toBe('true');
    await app.close();
  });
});
