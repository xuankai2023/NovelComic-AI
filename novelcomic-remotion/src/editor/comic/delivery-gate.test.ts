import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {projectContentHash} from './content-hash';
import {buildDeliveryPackage} from './export-package';
import type {DeliveryFileEntry} from './types';
import {verifyDeliveryPackage} from './verify-package';

const fullVideo = (): DeliveryFileEntry => ({
	path: 'final-video/full.mp4',
	category: 'final-video',
	order: 0,
	url: 'https://cdn.example.com/full.mp4',
});

const build = async ({
	files,
	inputContentHash,
}: {
	files: DeliveryFileEntry[];
	inputContentHash?: string;
}) => {
	const project = createComicProject();
	let archive: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	const result = await buildDeliveryPackage(
		{
			projectId: 'project-1',
			project,
			batches: [],
			files,
			inputSnapshotId: 'snapshot-1',
			inputRevision: 1,
			inputContentHash: inputContentHash ?? projectContentHash(project),
			preflightHash: 'preflight-1',
			generatedAt: '2026-10-06T00:00:00.000Z',
		},
		{
			download: async () => Buffer.from('video-bytes'),
			upload: async ({body}) => {
				archive = body;
			},
			readUrl: (key) => `https://delivery.example.com/${key}`,
		},
	);
	return {result, archive};
};

describe('delivery result gate', () => {
	it('marks a traced full-video package complete and verifies it', async () => {
		const {result, archive} = await build({files: [fullVideo()]});

		expect(result.deliveryStatus).toBe('delivery-complete');
		expect(result.packageChecksum).toMatch(/^[a-f0-9]{64}$/);
		const verification = verifyDeliveryPackage(archive);
		expect(verification.valid).toBe(true);
		expect(verification.deliveryStatus).toBe('delivery-complete');
	});

	it('keeps a ZIP downloadable but incomplete without full.mp4', async () => {
		const {result, archive} = await build({files: []});

		expect(result.packageUrl.startsWith('https://delivery.example.com/')).toBe(
			true,
		);
		expect(result.deliveryStatus).toBe('delivery-incomplete');
		expect(verifyDeliveryPackage(archive).deliveryStatus).toBe(
			'delivery-incomplete',
		);
	});

	it('rejects final delivery when the snapshot hash does not match', async () => {
		const {result, archive} = await build({
			files: [fullVideo()],
			inputContentHash: 'different-project-hash',
		});

		expect(result.deliveryStatus).toBe('delivery-incomplete');
		const verification = verifyDeliveryPackage(archive);
		expect(verification.valid).toBe(false);
		expect(verification.failures).toContain(
			'Input snapshot content hash does not match packaged project',
		);
	});
});
