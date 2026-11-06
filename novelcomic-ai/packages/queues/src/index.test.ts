import { describe, expect, it } from 'vitest';
import { QUEUE_NAMES, QUEUE_PREFIX, SMOKE_QUEUE_NAME } from './index.js';

describe('queue naming', () => {
  it('uses the shared novelcomic prefix', () => {
    expect(QUEUE_PREFIX).toBe('novelcomic');
    expect(SMOKE_QUEUE_NAME).toBe('smoke');
  });

  it('keeps the model task path on provider, artifact, then consumer callback', () => {
    expect(QUEUE_NAMES.providerExecution).toBe('provider-execution');
    expect(QUEUE_NAMES.artifactProcessing).toBe('artifact-processing');
    expect(QUEUE_NAMES.consumerCallback).toBe('consumer-callback');
    expect(QUEUE_NAMES.callbackDlq).toBe('consumer-callback-dlq');
    expect(QUEUE_NAMES.mediaFaceVerification).toBe('media-face-verification');
  });
});
