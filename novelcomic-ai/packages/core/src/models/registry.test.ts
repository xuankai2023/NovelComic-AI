import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listCoreModels } from '../model-runtime.js';

describe('core model registry', () => {
  it('lists Midjourney V8.1 and V8.2 and leaves the Youchuan video classes commented', () => {
    const models = listCoreModels();
    const labels = models.flatMap((model) => [model.id, model.displayName, ...(model.aliases ?? [])]);

    expect(labels.some((label) => label.includes('V8.1') || label.includes('v8-1'))).toBe(true);
    expect(labels.some((label) => label.includes('V8.2') || label.includes('v8-2'))).toBe(true);
    expect(models.some((model) => model.id.includes('youchuan-video'))).toBe(false);
    expect(models.some((model) => model.displayName === 'Youchuan Video')).toBe(false);

    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain('// YouchuanVideoTextToVideoModel');
    expect(source).toContain('// YouchuanVideoImageToVideoModel');
    expect(source).not.toMatch(/^import \{[^}]*YouchuanVideo/m);
  });
});