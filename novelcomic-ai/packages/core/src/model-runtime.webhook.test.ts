import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseCoreProviderWebhook, verifyTencentWebhookSignature } from './model-runtime.js';

describe('provider webhook verification', () => {
  it('ignores signature headers while parsing the webhook body', () => {
    const parsed = parseCoreProviderWebhook(
      'provider-a',
      { event_id: 'body-event', status: 'succeeded' },
      { 'x-provider-event': 'header-event', 'x-provider-signature': 'sig' },
    );

    expect(parsed).toEqual({
      event_id: 'body-event',
      provider_status: 'succeeded',
    });
  });

  it('rejects a Tencent signature that does not match SignKey + T', () => {
    const now = 1_800_000_000;
    expect(verifyTencentWebhookSignature({ Sign: 'nope', T: now + 30 }, 'sign-key', now)).toEqual({
      valid: false,
      reason: 'sign mismatch',
    });
    const signature = createHash('md5').update(`sign-key${now + 30}`, 'utf8').digest('hex');
    expect(verifyTencentWebhookSignature({ Sign: signature, T: now + 30 }, 'sign-key', now)).toEqual({
      valid: true,
    });
    const expiredAt = now - 1;
    const expiredSignature = createHash('md5').update(`sign-key${expiredAt}`, 'utf8').digest('hex');
    expect(verifyTencentWebhookSignature({ Sign: expiredSignature, T: expiredAt }, 'sign-key', now)).toEqual({
      valid: false,
      reason: 'signature expired',
    });
  });
});
