import {describe, expect, it, vi} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {addDialogue} from './add-dialogue';
import {addDialogueVoice} from './add-dialogue-voice';
import {appendImageSequence} from './append-image-sequence';
import {applyMotion} from './apply-motion';
import {buildDeliveryPackage} from './export-package';
import {finalizeBatchDelivery} from './finalize-batches';
import {importLayers} from './import-layers';
import {planOutputBatches} from './plan-batches';
import type {ComicLayer, DeliveryFileEntry, LayerPackage} from './types';
import {validateProject} from './validate-project';
import {upsertVoiceProfile} from './voice-profiles';

const generatedAt = '2026-10-04T00:00:00.000Z';
const hosts = ['cdn.test'];

const layer = (
	semantic: ComicLayer['semantic'],
	zIndex: number,
	bounds: ComicLayer['bounds'],
): ComicLayer => {
	return {
		layerId: semantic,
		name: semantic,
		semantic,
		imageUrl: `https://cdn.test/layers/${semantic}.png`,
		zIndex,
		visible: true,
		bounds,
		anchor: {x: 0.5, y: 0.5},
		confidence: 0.95,
		motionPolicy: 'subtle',
	};
};

const layerPackage = (): LayerPackage => {
	return {
		schemaVersion: 1,
		projectId: 'smoke-project',
		shotId: 'shot-1',
		sourceUrl: 'https://cdn.test/source/shot-1.png',
		canvas: {width: 1080, height: 1920},
		layers: [
			layer('background', 0, {x: 0, y: 0, width: 1080, height: 1920}),
			layer('body', 10, {x: 240, y: 420, width: 600, height: 1080}),
		],
		diagnostics: {
			recompositionScore: 0.08,
			alphaHoleRatio: 0,
			edgeArtifactScore: 0.02,
			requiresFallback: false,
			warnings: [],
		},
	};
};

const deliveryFile = (
	path: string,
	category: DeliveryFileEntry['category'],
	order: number,
): DeliveryFileEntry => {
	return {
		path,
		category,
		order,
		url: `https://cdn.test/${path}`,
		checksum: `sum-${path}`,
		sizeBytes: 10,
	};
};

describe('dynamic comic production smoke test', () => {
	it('builds, validates, finalizes, and packages a one-shot comic', async () => {
		let project = createComicProject();
		project = upsertVoiceProfile(project, {
			id: 'voice:hero',
			characterId: 'hero',
			provider: 'elevenlabs',
			voiceId: 'voice-hero',
			style: 'warm',
			defaultForCharacter: true,
		});
		project = appendImageSequence(project, {
			images: [
				{
					shotId: 'shot-1',
					url: 'https://cdn.test/source/shot-1.png',
					width: 1080,
					height: 1920,
					durationInFrames: 150,
					cameraPresetId: 'camera-push',
				},
			],
			allowedHosts: hosts,
		});
		project = importLayers(project, layerPackage(), {allowedHosts: hosts});
		project = addDialogue(project, {
			lines: [
				{
					shotId: 'shot-1',
					lineId: 'line-1',
					text: '第一句对白',
					from: 30,
					durationInFrames: 60,
					characterId: 'hero',
				},
			],
		});
		project = addDialogueVoice(
			project,
			{
				voices: [
					{
						shotId: 'shot-1',
						lineId: 'line-1',
						audioUrl: 'https://cdn.test/audio/line-1.mp3',
						from: 30,
						durationInFrames: 60,
						resolvedAudio: {
							remoteUrl: 'https://cdn.test/audio/line-1.mp3',
							filename: 'line-1.mp3',
							durationInSeconds: 3,
							size: 100,
							mimeType: 'audio/mpeg',
						},
					},
				],
			},
			{allowedHosts: hosts},
		);
		project = applyMotion(project, {
			target: {type: 'item', itemId: 'item:shot-1:body', presetId: 'breathing'},
			mode: 'replace',
			parameters: {scale: 1.015, period: 60},
			seed: 4,
		});

		const errors = validateProject(project).filter((issue) => {
			return issue.severity === 'error';
		});
		expect(errors).toEqual([]);

		const batches = planOutputBatches(project);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toMatchObject({
			fromFrame: 0,
			endFrameInclusive: 149,
			durationInFrames: 150,
			shotIds: ['shot-1'],
		});

		const finalized = finalizeBatchDelivery({
			projectId: 'smoke-project',
			project,
			batches,
			renderedBatches: [
				{
					batchId: batches[0]!.batchId,
					status: 'done',
					outputFile: 'https://cdn.test/final/shot-1.mp4',
					outputSizeInBytes: 1234,
					checksum: 'sum-final',
				},
			],
			files: [
				deliveryFile('source/shot-1.png', 'source', 0),
				deliveryFile('layers/body.png', 'layer', 0),
				deliveryFile('audio/line-1.mp3', 'audio', 0),
				deliveryFile('subtitle/line-1.json', 'subtitle', 0),
				deliveryFile('project/project.json', 'project', 0),
				deliveryFile('preview/shot-1.png', 'preview', 0),
			],
			generatedAt,
		});
		expect(finalized.incompleteBatches).toEqual([]);
		expect(finalized.playOrder).toEqual([
			`final-video/${batches[0]!.batchId}.mp4`,
		]);

		const uploads: Array<{key: string; body: Buffer; contentType: string}> = [];
		const packaged = await buildDeliveryPackage(
			{
				projectId: 'smoke-project',
				project,
				batches,
				files: finalized.manifest.files,
				generatedAt,
			},
			{
				download: vi.fn(async (url: string) => Buffer.from(`file:${url}`)),
				upload: async (input) => {
					uploads.push(input);
				},
				readUrl: (key) => `https://delivery.test/${key}`,
			},
		);

		expect(packaged.missingFiles).toEqual([]);
		expect(packaged.packageUrl).toBe(
			`https://delivery.test/${packaged.packageKey}`,
		);
		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.contentType).toBe('application/zip');
		expect(uploads[0]?.body.subarray(0, 4).toString('hex')).toBe('504b0304');
	});
});
