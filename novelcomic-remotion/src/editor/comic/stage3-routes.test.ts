import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {POST as editItemRoute} from '../../../app/api/compose/item/edit/route';
import {POST as motionRoute} from '../../../app/api/compose/item/motion/route';
import {POST as importLayersRoute} from '../../../app/api/compose/layers/import/route';
import {POST as deleteShotRoute} from '../../../app/api/compose/shot/delete/route';
import {POST as editShotRoute} from '../../../app/api/compose/shot/edit/route';
import {createComicProject} from '../compose/build-state';
import type {UndoableState} from '../state/types';
import {appendImageSequence, panelIds} from './append-image-sequence';
import {importLayers} from './import-layers';
import type {LayerPackage} from './types';
import {upsertShot} from './upsert-shot';

const originalHosts = process.env.COMIC_ALLOWED_REMOTE_HOSTS;

const post = async (
	route: (request: Request) => Promise<Response>,
	body: unknown,
) => {
	const response = await route(
		new Request('https://editor.local/api', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}),
	);
	const json = (await response.json()) as Record<string, unknown>;
	return {response, json};
};

const layerPackage = (): LayerPackage => {
	return {
		schemaVersion: 1,
		projectId: 'project-1',
		shotId: 'shot-1',
		sourceUrl: 'https://cdn.example.com/source.png',
		canvas: {width: 1080, height: 1920},
		layers: [
			{
				layerId: 'bg',
				name: 'bg',
				semantic: 'background',
				imageUrl: 'https://cdn.example.com/bg.png',
				zIndex: 0,
				visible: true,
				bounds: {x: 0, y: 0, width: 1080, height: 1920},
				anchor: {x: 0.5, y: 0.5},
				confidence: 1,
				motionPolicy: 'static',
			},
			{
				layerId: 'face',
				name: 'face',
				semantic: 'body',
				imageUrl: 'https://cdn.example.com/body.png',
				zIndex: 2,
				visible: true,
				bounds: {x: 100, y: 200, width: 400, height: 600},
				anchor: {x: 0.5, y: 0.5},
				confidence: 1,
				motionPolicy: 'subtle',
			},
			{
				layerId: 'eye-open',
				name: 'eye-open',
				semantic: 'eye-open',
				imageUrl: 'https://cdn.example.com/eye-open.png',
				zIndex: 4,
				visible: true,
				bounds: {x: 200, y: 300, width: 100, height: 50},
				anchor: {x: 0.5, y: 0.5},
				confidence: 1,
				motionPolicy: 'static',
			},
			{
				layerId: 'eye-closed',
				name: 'eye-closed',
				semantic: 'eye-closed',
				imageUrl: 'https://cdn.example.com/eye-closed.png',
				zIndex: 4,
				visible: true,
				bounds: {x: 200, y: 300, width: 100, height: 50},
				anchor: {x: 0.5, y: 0.5},
				confidence: 1,
				motionPolicy: 'static',
			},
		],
		diagnostics: {
			recompositionScore: 0,
			alphaHoleRatio: 0,
			edgeArtifactScore: 0,
			requiresFallback: false,
			warnings: [],
		},
	};
};

describe('stage 3 compose routes', () => {
	beforeEach(() => {
		process.env.COMIC_ALLOWED_REMOTE_HOSTS = 'cdn.example.com';
	});

	afterEach(() => {
		if (originalHosts === undefined) {
			delete process.env.COMIC_ALLOWED_REMOTE_HOSTS;
		} else {
			process.env.COMIC_ALLOWED_REMOTE_HOSTS = originalHosts;
		}
	});

	it('edits a shot, imports layers idempotently, and writes motion', async () => {
		const sequenced = appendImageSequence(createComicProject(), {
			allowedHosts: ['cdn.example.com'],
			images: [
				{
					shotId: 'shot-1',
					url: 'https://cdn.example.com/one.png',
					width: 1080,
					height: 1920,
					durationInFrames: 60,
				},
				{
					shotId: 'shot-2',
					url: 'https://cdn.example.com/two.png',
					width: 1080,
					height: 1920,
					durationInFrames: 60,
				},
			],
		});
		const edited = await post(editShotRoute, {
			project: sequenced,
			shotId: 'shot-1',
			durationInFrames: 90,
		});
		expect(edited.response.status).toBe(200);
		const editedProject = edited.json.project as {
			shots: Array<{id: string; from: number; durationInFrames: number}>;
		};
		expect(editedProject.shots.map((shot) => shot.from)).toEqual([0, 90]);

		const imported = await post(importLayersRoute, {
			project: upsertShot(createComicProject(), {
				shotId: 'shot-1',
				durationInFrames: 45,
			}),
			layerPackage: layerPackage(),
		});
		expect(imported.response.status).toBe(200);
		const first = imported.json.project as UndoableState;
		const again = importLayers(first, layerPackage(), {
			allowedHosts: ['cdn.example.com'],
		});
		expect(again.tracks).toHaveLength(first.tracks.length);
		const blink = await post(motionRoute, {
			project: first,
			target: {type: 'item', itemId: 'item:shot-1:eye'},
			mode: 'replace',
			sprite: {
				kind: 'blink',
				openAssetId: 'asset:shot-1:eye:open',
				closedAssetId: 'asset:shot-1:eye:closed',
				seed: 7,
			},
		});
		expect(blink.response.status).toBe(200);
		const blinkProject = blink.json.project as UndoableState;
		const eye = blinkProject.items['item:shot-1:eye'];
		expect(
			eye?.type === 'image' ? eye.motion?.spriteStates?.length : 0,
		).toBeGreaterThan(1);

		const moved = await post(motionRoute, {
			project: sequenced,
			target: {
				type: 'item',
				itemId: panelIds('shot-1').itemId,
				presetId: 'breathing',
			},
			mode: 'replace',
		});
		expect(moved.response.status).toBe(422);
		expect(moved.json.code).toBe('DOMAIN_INVARIANT');

		const removed = await post(deleteShotRoute, {
			project: sequenced,
			shotId: 'shot-2',
		});
		expect(removed.response.status).toBe(200);
		const removedProject = removed.json.project as {shots: Array<{id: string}>};
		expect(removedProject.shots.map((shot) => shot.id)).toEqual(['shot-1']);
	});

	it('keeps the legacy item edit error string and blocks shot timing', async () => {
		const item = {
			id: 'hero',
			type: 'image',
			assetId: 'hero-asset',
			durationInFrames: 30,
			from: 0,
			top: 0,
			left: 0,
			width: 10,
			height: 10,
			opacity: 1,
			isDraggingInTimeline: false,
			borderRadius: 0,
			rotation: 0,
			keepAspectRatio: true,
			fadeInDurationInSeconds: 0,
			fadeOutDurationInSeconds: 0,
			cropLeft: 0,
			cropTop: 0,
			cropRight: 0,
			cropBottom: 0,
			shotId: 'shot-1',
			layerId: 'hero',
		};
		const project = {
			...createComicProject(),
			items: {[item.id]: item},
		};
		const moved = await post(editItemRoute, {
			project,
			itemId: item.id,
			patch: {left: 14, opacity: 0.4},
		});
		expect(moved.response.status).toBe(200);
		expect(moved.json.type).toBe('success');
		expect(moved.json.item).toMatchObject({left: 14, opacity: 0.4});

		const blocked = await post(editItemRoute, {
			project,
			itemId: item.id,
			patch: {durationMs: 1000},
		});
		expect(blocked.response.status).toBe(422);
		expect(typeof blocked.json.error).toBe('string');
		expect(blocked.json.error).toMatch(/editShot or deleteShot/);
	});
});
