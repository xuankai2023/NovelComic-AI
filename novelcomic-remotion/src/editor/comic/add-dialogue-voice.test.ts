import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {addDialogue} from './add-dialogue';
import {
	addDialogueVoice,
	dialogueVoiceIds,
	type DialogueVoiceInput,
} from './add-dialogue-voice';
import {upsertShot} from './upsert-shot';

const projectWithDialogue = () => {
	const project = upsertShot(createComicProject(), {
		shotId: 'shot-1',
		durationInFrames: 90,
	});
	return addDialogue(project, {
		lines: [
			{
				shotId: 'shot-1',
				lineId: 'line-1',
				text: '第一句',
				from: 15,
				durationInFrames: 30,
			},
		],
	});
};

const voice = (overrides?: Partial<DialogueVoiceInput>): DialogueVoiceInput => {
	return {
		shotId: 'shot-1',
		lineId: 'line-1',
		audioUrl: 'https://cdn.test/line-1.mp3',
		from: 15,
		durationInFrames: 30,
		sourceStartInSeconds: 0,
		decibelAdjustment: 0,
		resolvedAudio: {
			remoteUrl: 'https://cdn.test/line-1.mp3',
			filename: 'line-1.mp3',
			durationInSeconds: 1.5,
			size: 100,
			mimeType: 'audio/mpeg',
		},
		...overrides,
	};
};

describe('addDialogueVoice', () => {
	it('upserts stable voice asset, item, and track ids', () => {
		const project = projectWithDialogue();
		const first = addDialogueVoice(
			project,
			{voices: [voice()]},
			{allowedHosts: ['cdn.test']},
		);
		const repeated = addDialogueVoice(
			first,
			{voices: [voice({decibelAdjustment: -3})]},
			{allowedHosts: ['cdn.test']},
		);
		const ids = dialogueVoiceIds('shot-1', 'line-1');

		expect(repeated.tracks).toHaveLength(first.tracks.length);
		expect(repeated.assets[ids.assetId]).toMatchObject({
			id: ids.assetId,
			type: 'audio',
		});
		expect(repeated.items[ids.itemId]).toMatchObject({
			id: ids.itemId,
			type: 'audio',
			from: 15,
			durationInFrames: 30,
			decibelAdjustment: -3,
		});
		expect(
			repeated.tracks.find((track) => track.id === ids.trackId),
		).toMatchObject({
			items: [ids.itemId],
			shotId: 'shot-1',
		});
		expect(project.tracks).toHaveLength(1);
	});

	it('rejects non-allowlisted URLs and timing outside the dialogue', () => {
		const project = projectWithDialogue();
		expect(() => {
			addDialogueVoice(
				project,
				{voices: [voice({audioUrl: 'https://other.test/line.mp3'})]},
				{allowedHosts: ['cdn.test']},
			);
		}).toThrow(/allowlisted/);
		expect(() => {
			addDialogueVoice(
				project,
				{voices: [voice({from: 10, durationInFrames: 30})]},
				{allowedHosts: ['cdn.test']},
			);
		}).toThrow(/inside its dialogue/);
	});
});
