import {describe, expect, it, vi} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import {createComicProject} from '../compose/build-state';
import {buildDeliveryPackage} from './export-package';
import type {ComicEditLayer} from './manual-layer-types';
import type {DeliveryFileEntry, OutputBatch} from './types';
import {upsertShot} from './upsert-shot';

const generatedAt = '2026-10-03T00:00:00.000Z';

const batch = (): OutputBatch => {
	return {
		batchId: 'batch-a',
		batchIndex: 0,
		fromFrame: 0,
		endFrameInclusive: 149,
		durationInFrames: 150,
		shotIds: ['shot-1'],
		reason: 'target-range',
	};
};

const file = (
	path: string,
	category: DeliveryFileEntry['category'],
	extra?: Partial<DeliveryFileEntry>,
): DeliveryFileEntry => {
	return {
		path,
		category,
		order: 0,
		...extra,
	};
};

const imageAsset = (id: string, width: number, height: number): ImageAsset => ({
	id,
	type: 'image',
	filename: `${id}.png`,
	size: 1,
	remoteUrl: `https://cdn.example.com/${id}.png`,
	remoteFileKey: null,
	mimeType: 'image/png',
	width,
	height,
});

const manualLayer = (): ComicEditLayer => ({
	id: 'hair',
	name: 'Hair',
	semantic: 'hair',
	sourceAssetId: 'source',
	shotId: 'shot-1',
	sourceCanvas: {width: 100, height: 100},
	bounds: {x: 10, y: 20, width: 30, height: 40},
	polygon: [
		{x: 10, y: 20},
		{x: 40, y: 20},
		{x: 40, y: 60},
	],
	maskAssetId: 'mask',
	cutoutAssetId: 'hair',
	visible: true,
	locked: false,
	opacity: 1,
	zIndex: 10,
});

describe('buildDeliveryPackage', () => {
	it('uploads a zip containing project, manifest, file index, and downloaded files', async () => {
		const uploads: Array<{key: string; body: Buffer; contentType: string}> = [];
		const download = vi.fn(async (url: string) => {
			return Buffer.from(`downloaded:${url}`);
		});

		const result = await buildDeliveryPackage(
			{
				projectId: 'project-1',
				project: createComicProject(),
				batches: [batch()],
				files: [
					file('source/page.png', 'source', {
						url: 'https://cdn.example.com/page.png',
						checksum: 'sum-source',
					}),
					file('videos/a.mp4', 'final-video', {
						url: 'https://cdn.example.com/a.mp4',
						checksum: 'sum-video',
					}),
				],
				generatedAt,
			},
			{
				download,
				upload: async (input) => {
					uploads.push(input);
				},
				readUrl: (key) => `https://delivery.example.com/${key}`,
			},
		);

		expect(result.packageUrl).toBe(
			`https://delivery.example.com/${result.packageKey}`,
		);
		expect(result.packageSizeBytes).toBeGreaterThan(0);
		expect(result.missingFiles.map((entry) => entry.path)).toEqual([
			'missing/layer',
			'missing/audio',
			'missing/subtitle',
			'missing/project',
			'missing/preview',
		]);
		expect(download).toHaveBeenCalledWith('https://cdn.example.com/page.png');
		expect(download).toHaveBeenCalledWith('https://cdn.example.com/a.mp4');
		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.contentType).toBe('application/zip');
		expect(uploads[0]?.body.subarray(0, 4).toString('hex')).toBe('504b0304');
		expect(uploads[0]?.body.includes(Buffer.from('manifest.json'))).toBe(true);
		expect(uploads[0]?.body.includes(Buffer.from('project/project.json'))).toBe(
			true,
		);
		expect(uploads[0]?.body.includes(Buffer.from('files.json'))).toBe(true);
		expect(uploads[0]?.body.includes(Buffer.from('source/page.png'))).toBe(
			true,
		);
	});

	it('keeps a package usable when an individual file cannot be downloaded', async () => {
		const upload = vi.fn(async () => undefined);
		const result = await buildDeliveryPackage(
			{
				projectId: 'project-1',
				project: createComicProject(),
				batches: [],
				files: [
					file('source/page.png', 'source', {
						url: 'https://cdn.example.com/page.png',
						checksum: 'sum-source',
					}),
				],
				generatedAt,
			},
			{
				download: async () => {
					throw new Error('network down');
				},
				upload,
				readUrl: (key) => `https://delivery.example.com/${key}`,
			},
		);

		expect(upload).toHaveBeenCalledOnce();
		expect(result.missingFiles).toContainEqual({
			path: 'source/page.png',
			reason: 'Could not download file: network down',
			url: 'https://cdn.example.com/page.png',
		});
		expect(result.warnings).toContain(
			'source/page.png: Could not download file: network down',
		);
	});

	it('downloads remote files without a precomputed checksum and fills it in', async () => {
		const result = await buildDeliveryPackage(
			{
				projectId: 'project-1',
				project: createComicProject(),
				batches: [],
				files: [
					file('source/page.png', 'source', {
						url: 'https://cdn.example.com/page.png',
					}),
				],
				generatedAt,
			},
			{
				download: async () => Buffer.from('page-bytes'),
				upload: async () => undefined,
				readUrl: (key) => `https://delivery.example.com/${key}`,
			},
		);

		expect(result.missingFiles).not.toContainEqual(
			expect.objectContaining({path: 'source/page.png'}),
		);
		expect(result.manifest.files).toContainEqual(
			expect.objectContaining({
				path: 'source/page.png',
				checksum: expect.any(String),
				sizeBytes: 10,
			}),
		);
	});

	it('exports manual transparent layers, masks, and LayerPackage metadata', async () => {
		const project = upsertShot(createComicProject(), {
			shotId: 'shot-1',
			durationInFrames: 30,
		});
		project.assets.source = imageAsset('source', 100, 100);
		project.assets.hair = imageAsset('hair', 30, 40);
		project.assets.mask = imageAsset('mask', 100, 100);
		project.comicEditLayers = {hair: manualLayer()};
		const download = vi.fn(async (url: string) => Buffer.from(`png:${url}`));

		const result = await buildDeliveryPackage(
			{
				projectId: 'project-1',
				project,
				batches: [],
				files: [],
				generatedAt,
			},
			{
				download,
				upload: async () => undefined,
				readUrl: (key) => `https://delivery.example.com/${key}`,
			},
		);

		expect(result.manifest.layerPackages).toHaveLength(1);
		expect(result.manifest.layerPackages?.[0]?.layers[0]).toMatchObject({
			bounds: {x: 10, y: 20, width: 30, height: 40},
			anchor: {x: 0.5, y: 0},
			semantic: 'hair',
			maskUrl: 'https://cdn.example.com/mask.png',
		});
		expect(result.manifest.files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: 'layers/shot-1/hair.png',
					checksum: expect.any(String),
				}),
				expect.objectContaining({
					path: 'layers/shot-1/hair.mask.png',
					checksum: expect.any(String),
				}),
			]),
		);
		expect(download).toHaveBeenCalledWith('https://cdn.example.com/hair.png');
		expect(download).toHaveBeenCalledWith('https://cdn.example.com/mask.png');
	});
});
