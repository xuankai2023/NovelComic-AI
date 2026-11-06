import {describe, expect, it} from 'vitest';
import {createComicProject} from '../compose/build-state';
import {addDialogue, dialogueIds} from './add-dialogue';
import {
	addDialogueVoice,
	dialogueVoiceIds,
	type DialogueVoiceInput,
} from './add-dialogue-voice';
import {upsertShot} from './upsert-shot';
import {upsertVoiceProfile} from './voice-profiles';

const projectWithVoiceProfile = () => {
	const project = upsertShot(createComicProject(), {
		shotId: 'shot-1',
		durationInFrames: 90,
	});
	return upsertVoiceProfile(project, {
		id: 'voice:hero:default',
		characterId: 'hero',
		displayName: 'Hero',
		provider: 'elevenlabs',
		voiceId: 'eleven-hero',
		style: 'calm',
		language: 'zh',
		defaultForCharacter: true,
	});
};

const voice = (overrides?: Partial<DialogueVoiceInput>): DialogueVoiceInput => {
	return {
		shotId: 'shot-1',
		lineId: 'line-1',
		audioUrl: 'https://cdn.test/line-1.mp3',
		from: 0,
		durationInFrames: 30,
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

describe('voice profiles', () => {
	it('assigns the default character voice profile to dialogue and voice items', () => {
		const withDialogue = addDialogue(projectWithVoiceProfile(), {
			lines: [
				{
					shotId: 'shot-1',
					lineId: 'line-1',
					text: '你好',
					from: 0,
					durationInFrames: 30,
					characterId: 'hero',
				},
			],
		});
		const dialogueItem =
			withDialogue.items[dialogueIds('shot-1', 'line-1').itemId];

		expect(dialogueItem).toMatchObject({
			type: 'captions',
			characterId: 'hero',
			voiceProfileId: 'voice:hero:default',
		});

		const withVoice = addDialogueVoice(
			withDialogue,
			{voices: [voice()]},
			{allowedHosts: ['cdn.test']},
		);
		expect(
			withVoice.items[dialogueVoiceIds('shot-1', 'line-1').itemId],
		).toMatchObject({
			type: 'audio',
			characterId: 'hero',
			voiceProfileId: 'voice:hero:default',
			voiceProvider: 'elevenlabs',
			voiceId: 'eleven-hero',
			voiceStyle: 'calm',
		});
	});

	it('rejects explicit missing or mismatched voice profiles', () => {
		expect(() => {
			addDialogue(projectWithVoiceProfile(), {
				lines: [
					{
						shotId: 'shot-1',
						lineId: 'line-1',
						text: '坏配置',
						from: 0,
						durationInFrames: 30,
						voiceProfileId: 'missing',
					},
				],
			});
		}).toThrow(/does not exist/);

		const withDialogue = addDialogue(projectWithVoiceProfile(), {
			lines: [
				{
					shotId: 'shot-1',
					lineId: 'line-1',
					text: '你好',
					from: 0,
					durationInFrames: 30,
					characterId: 'hero',
				},
			],
		});

		expect(() => {
			addDialogueVoice(
				withDialogue,
				{voices: [voice({characterId: 'villain'})]},
				{allowedHosts: ['cdn.test']},
			);
		}).toThrow(/does not match dialogue character/);
	});
});
