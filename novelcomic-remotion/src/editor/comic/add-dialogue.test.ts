import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {addDialogue, dialogueIds} from './add-dialogue';
import {ComicEditorError} from './errors';
import {upsertShot} from './upsert-shot';

const projectWithShot = (durationInFrames: number) => {
	return upsertShot(createComicProject(), {
		shotId: 'shot-1',
		durationInFrames,
	});
};

describe('addDialogue', () => {
	it('adds several lines inside the shot and updates a repeated line id', () => {
		const project = projectWithShot(90);
		const added = addDialogue(project, {
			lines: [
				{
					lineId: 'line-1',
					shotId: 'shot-1',
					text: '第一句',
					from: 0,
					durationInFrames: 30,
				},
				{
					lineId: 'line-2',
					shotId: 'shot-1',
					text: '第二句',
					from: 30,
					durationInFrames: 30,
				},
			],
		});
		const repeated = addDialogue(added, {
			lines: [
				{
					lineId: 'line-1',
					shotId: 'shot-1',
					text: '改写',
					from: 0,
					durationInFrames: 20,
				},
			],
		});
		const first = dialogueIds('shot-1', 'line-1');
		const asset = repeated.assets[first.assetId];

		expect(added.shots?.[0]?.dialogueItemIds).toEqual([
			dialogueIds('shot-1', 'line-1').itemId,
			dialogueIds('shot-1', 'line-2').itemId,
		]);
		expect(added.tracks).toHaveLength(2);
		expect(repeated.tracks).toHaveLength(2);
		expect(repeated.shots?.[0]?.dialogueItemIds).toHaveLength(2);
		expect(repeated.items[first.itemId]).toMatchObject({
			type: 'captions',
			from: 0,
			durationInFrames: 20,
		});
		expect(asset?.type).toBe('caption');
		if (asset?.type === 'caption') {
			expect(asset.captions[0]?.text).toBe('改写');
		}

		expect(project.tracks).toEqual([]);
	});

	it('accepts the shot boundaries and rejects lines outside the shot', () => {
		const project = projectWithShot(90);
		const onBoundary = addDialogue(project, {
			lines: [
				{
					lineId: 'full',
					shotId: 'shot-1',
					text: '整段',
					from: 0,
					durationInFrames: 90,
				},
			],
		});
		expect(onBoundary.items[dialogueIds('shot-1', 'full').itemId]?.from).toBe(
			0,
		);

		const lastFrame = addDialogue(project, {
			lines: [
				{
					lineId: 'last',
					shotId: 'shot-1',
					text: '末帧',
					from: 89,
					durationInFrames: 1,
				},
			],
		});
		expect(lastFrame.items[dialogueIds('shot-1', 'last').itemId]?.from).toBe(
			89,
		);

		const snapshot = structuredClone(project);
		expect(() => {
			addDialogue(project, {
				lines: [
					{
						lineId: 'over',
						shotId: 'shot-1',
						text: '越界',
						from: 80,
						durationInFrames: 11,
					},
				],
			});
		}).toThrow(ComicEditorError);
		expect(() => {
			addDialogue(project, {
				lines: [
					{
						lineId: 'before',
						shotId: 'shot-1',
						text: '提前',
						from: 0,
						durationInFrames: 10,
					},
					{
						lineId: 'after',
						shotId: 'shot-1',
						text: '越界',
						from: 90,
						durationInFrames: 1,
					},
				],
			});
		}).toThrow(/falls outside shot/);
		expect(project).toEqual(snapshot);
	});

	it('upserts visibility without creating a second dialogue track', () => {
		const project = projectWithShot(90);
		const hidden = addDialogue(project, {
			lines: [
				{
					lineId: 'line-1',
					shotId: 'shot-1',
					text: '保留气泡',
					from: 0,
					durationInFrames: 30,
					visible: false,
				},
			],
		});
		const visible = addDialogue(hidden, {
			lines: [
				{
					lineId: 'line-1',
					shotId: 'shot-1',
					text: '配音失败后显示字幕',
					from: 0,
					durationInFrames: 30,
					visible: true,
				},
			],
		});
		const ids = dialogueIds('shot-1', 'line-1');

		expect(hidden.tracks.find((track) => track.id === ids.trackId)?.hidden).toBe(
			true,
		);
		expect(
			visible.tracks.find((track) => track.id === ids.trackId)?.hidden,
		).toBe(false);
		expect(visible.tracks).toHaveLength(1);
	});
});
