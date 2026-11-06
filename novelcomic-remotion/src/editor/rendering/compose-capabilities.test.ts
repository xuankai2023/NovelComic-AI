import {describe, expect, it} from 'vitest';
import {inspectComposeCapabilities} from './compose-capabilities';

describe('inspectComposeCapabilities', () => {
	it('reports complete configuration without exposing secret values', async () => {
		const result = await inspectComposeCapabilities({
			env: {
				REMOTION_RENDER_BACKEND: 'lambda',
				REMOTION_AWS_REGION: 'us-east-1',
				REMOTION_AWS_BUCKET_NAME: 'bucket',
				COS_SECRET_ID: 'secret-id',
				COS_SECRET_KEY: 'secret-key',
				COS_REGION: 'ap-shanghai',
				COS_BUCKET: 'bucket',
				COS_CDN_DOMAIN: 'https://cdn.example.com',
			},
			fonts: ['Roboto'],
			checks: {localRenderer: () => true, ffmpeg: async () => true},
		});

		expect(result.lambda.configured).toBe(true);
		expect(result.cos.configured).toBe(true);
		expect(JSON.stringify(result)).not.toContain('secret-key');
	});

	it('returns actionable missing configuration and fonts', async () => {
		const result = await inspectComposeCapabilities({
			env: {REMOTION_RENDER_BACKEND: 'local'},
			fonts: ['Missing Font'],
			checks: {localRenderer: () => false, ffmpeg: async () => false},
		});

		expect(result.local.available).toBe(false);
		expect(result.ffmpeg.available).toBe(false);
		expect(result.cos.configured).toBe(false);
		expect(result.fonts).toEqual({available: false, missing: ['Missing Font']});
	});
});
