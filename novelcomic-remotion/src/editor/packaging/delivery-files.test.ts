import {describe, expect, it} from 'vitest';
import {collectDeliveryFiles, verifyDeliveryFiles} from './delivery-files';

describe('delivery files', () => {
	it('normalizes paths and computes checksums', () => {
		const files = collectDeliveryFiles([
			{path: './project/../project/project.json', category: 'project', body: '{}'},
		]);
		expect(files[0]?.path).toBe('project/project.json');
		expect(files[0]?.sizeBytes).toBe(2);
		expect(files[0]?.checksum).toHaveLength(64);
		expect(() => verifyDeliveryFiles(files)).not.toThrow();
	});

	it('rejects duplicate or unsafe paths', () => {
		expect(() =>
			collectDeliveryFiles([
				{path: 'project.json', category: 'project', body: '{}'},
				{path: 'project.json', category: 'project', body: '{}'},
			]),
		).toThrow(/Duplicate/);
		expect(() =>
			collectDeliveryFiles([
				{path: '/etc/passwd', category: 'source', body: 'x'},
			]),
		).toThrow(/Invalid/);
	});
});
