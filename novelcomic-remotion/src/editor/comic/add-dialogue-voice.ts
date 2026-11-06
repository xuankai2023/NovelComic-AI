import type {ResolvedAudioInput} from '../compose/build-audio-item';
import {buildAudioAsset, buildAudioItem} from '../compose/build-audio-item';
import {
	resolveAllowedHosts,
	validateRemoteUrl,
} from '../compose/validate-remote-url';
import type {UndoableState} from '../state/types';
import {dialogueIds} from './add-dialogue';
import {domainInvariant} from './errors';
import {MAX_ASSETS, MAX_ITEMS} from './limits';
import {cloneUndoableState} from './upsert-shot';
import {resolveVoiceProfileMetadata} from './voice-profiles';

export type DialogueVoiceInput = {
	shotId: string;
	lineId: string;
	audioUrl: string;
	from: number;
	durationInFrames: number;
	sourceStartInSeconds?: number;
	decibelAdjustment?: number;
	characterId?: string;
	voiceProfileId?: string;
	resolvedAudio: ResolvedAudioInput;
};

export type AddDialogueVoiceInput = {
	voices: DialogueVoiceInput[];
};

export type AddDialogueVoiceOptions = {
	allowedHosts?: readonly string[];
};

export const dialogueVoiceIds = (
	shotId: string,
	lineId: string,
): {assetId: string; itemId: string; trackId: string} => {
	return {
		assetId: `voice:${shotId}:${lineId}`,
		itemId: `voice-item:${shotId}:${lineId}`,
		trackId: `track:${shotId}:voice:${lineId}`,
	};
};

const writeVoice = (
	project: UndoableState,
	voice: DialogueVoiceInput,
	allowedHosts: readonly string[],
): UndoableState => {
	const shot = (project.shots ?? []).find((entry) => {
		return entry.id === voice.shotId;
	});
	if (!shot) {
		throw domainInvariant(`Shot ${voice.shotId} does not exist`, {
			shotId: voice.shotId,
		});
	}

	const dialogueItemId = dialogueIds(voice.shotId, voice.lineId).itemId;
	const dialogue = project.items[dialogueItemId];
	if (!dialogue || dialogue.type !== 'captions') {
		throw domainInvariant(
			`Dialogue ${voice.lineId} does not exist in shot ${voice.shotId}`,
			{shotId: voice.shotId, itemId: dialogueItemId},
		);
	}

	if (
		voice.characterId &&
		dialogue.characterId &&
		voice.characterId !== dialogue.characterId
	) {
		throw domainInvariant(
			`Voice character ${voice.characterId} does not match dialogue character ${dialogue.characterId}`,
			{shotId: voice.shotId, itemId: dialogueItemId},
		);
	}

	if (
		voice.voiceProfileId &&
		dialogue.voiceProfileId &&
		voice.voiceProfileId !== dialogue.voiceProfileId
	) {
		throw domainInvariant(
			`Voice profile ${voice.voiceProfileId} does not match dialogue profile ${dialogue.voiceProfileId}`,
			{shotId: voice.shotId, itemId: dialogueItemId},
		);
	}

	if (
		!Number.isInteger(voice.from) ||
		!Number.isInteger(voice.durationInFrames) ||
		voice.from < dialogue.from ||
		voice.durationInFrames < 1 ||
		voice.from + voice.durationInFrames >
			dialogue.from + dialogue.durationInFrames ||
		voice.from < shot.from ||
		voice.from + voice.durationInFrames > shot.from + shot.durationInFrames
	) {
		throw domainInvariant(
			'Voice timing must stay inside its dialogue and shot',
			{
				shotId: voice.shotId,
				itemId: dialogueItemId,
			},
		);
	}

	validateRemoteUrl(voice.audioUrl, {allowedHosts});
	if (voice.resolvedAudio.remoteUrl !== voice.audioUrl) {
		throw domainInvariant('Resolved audio URL does not match voice audioUrl', {
			shotId: voice.shotId,
		});
	}

	const sourceStartInSeconds = voice.sourceStartInSeconds ?? 0;
	if (!Number.isFinite(sourceStartInSeconds) || sourceStartInSeconds < 0) {
		throw domainInvariant('sourceStartInSeconds must be non-negative', {
			shotId: voice.shotId,
		});
	}

	const availableSeconds =
		voice.resolvedAudio.durationInSeconds - sourceStartInSeconds;
	const requestedSeconds = voice.durationInFrames / project.fps;
	if (
		!Number.isFinite(availableSeconds) ||
		availableSeconds <= 0 ||
		requestedSeconds > availableSeconds + 1 / project.fps
	) {
		throw domainInvariant('Voice duration exceeds the audio asset', {
			shotId: voice.shotId,
		});
	}

	const ids = dialogueVoiceIds(voice.shotId, voice.lineId);
	if (
		project.assets[ids.assetId] === undefined &&
		Object.keys(project.assets).length >= MAX_ASSETS
	) {
		throw domainInvariant(`Asset count cannot exceed ${MAX_ASSETS}`, {
			shotId: voice.shotId,
			assetId: ids.assetId,
		});
	}

	if (
		project.items[ids.itemId] === undefined &&
		Object.keys(project.items).length >= MAX_ITEMS
	) {
		throw domainInvariant(`Item count cannot exceed ${MAX_ITEMS}`, {
			shotId: voice.shotId,
			itemId: ids.itemId,
		});
	}

	const asset = buildAudioAsset(voice.resolvedAudio, ids.assetId);
	const item = buildAudioItem({
		asset,
		itemId: ids.itemId,
		fromFrame: voice.from,
		durationInFrames: voice.durationInFrames,
		audioStartFromInSeconds: sourceStartInSeconds,
		decibelAdjustment: voice.decibelAdjustment ?? 0,
		audioFadeInDurationInSeconds: 0,
		audioFadeOutDurationInSeconds: 0,
	});
	const voiceMetadata = resolveVoiceProfileMetadata(project, {
		characterId: voice.characterId ?? dialogue.characterId,
		voiceProfileId: voice.voiceProfileId ?? dialogue.voiceProfileId,
	});
	const itemWithVoice = {
		...item,
		lineId: voice.lineId,
		shotId: voice.shotId,
		...(voiceMetadata.characterId
			? {characterId: voiceMetadata.characterId}
			: {}),
		...(voiceMetadata.voiceProfileId
			? {voiceProfileId: voiceMetadata.voiceProfileId}
			: {}),
		...(voiceMetadata.voiceProvider
			? {voiceProvider: voiceMetadata.voiceProvider}
			: {}),
		...(voiceMetadata.voiceId ? {voiceId: voiceMetadata.voiceId} : {}),
		...(voiceMetadata.voiceStyle ? {voiceStyle: voiceMetadata.voiceStyle} : {}),
	};
	const tracks = project.tracks.some((track) => {
		return track.id === ids.trackId;
	})
		? project.tracks.map((track) => {
				if (track.id !== ids.trackId) {
					return track;
				}

				return {
					...track,
					items: [itemWithVoice.id],
					hidden: false,
					muted: false,
					name: `voice:${voice.lineId}`,
					shotId: voice.shotId,
					semantic: 'dialogue' as const,
				};
			})
		: [
				...project.tracks,
				{
					id: ids.trackId,
					items: [itemWithVoice.id],
					hidden: false,
					muted: false,
					name: `voice:${voice.lineId}`,
					shotId: voice.shotId,
					semantic: 'dialogue' as const,
				},
			];

	return {
		...project,
		tracks,
		assets: {...project.assets, [asset.id]: asset},
		items: {...project.items, [itemWithVoice.id]: itemWithVoice},
	};
};

export const addDialogueVoice = (
	project: UndoableState,
	input: AddDialogueVoiceInput,
	options?: AddDialogueVoiceOptions,
): UndoableState => {
	if (input.voices.length === 0) {
		throw domainInvariant('At least one dialogue voice is required');
	}

	const allowedHosts = resolveAllowedHosts(options?.allowedHosts);
	return input.voices.reduce((current, voice) => {
		return writeVoice(current, voice, allowedHosts);
	}, cloneUndoableState(project));
};
