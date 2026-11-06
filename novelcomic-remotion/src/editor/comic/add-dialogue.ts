import type {CaptionAsset} from '../assets/assets';
import {
	buildCaptionAsset,
	buildCaptionsItem,
} from '../compose/build-caption-item';
import type {UndoableState} from '../state/types';
import {domainInvariant} from './errors';
import {MAX_ASSETS, MAX_ITEMS} from './limits';
import type {Shot} from './types';
import {cloneUndoableState} from './upsert-shot';
import {resolveVoiceProfileMetadata} from './voice-profiles';

export type DialogueLineInput = {
	lineId: string;
	shotId: string;
	text: string;
	from: number;
	durationInFrames: number;
	visible?: boolean;
	characterId?: string;
	voiceProfileId?: string;
};

export type AddDialogueInput = {
	lines: DialogueLineInput[];
};

export const dialogueIds = (
	shotId: string,
	lineId: string,
): {assetId: string; itemId: string; trackId: string} => {
	return {
		assetId: `caption:${shotId}:${lineId}`,
		itemId: `dialogue:${shotId}:${lineId}`,
		trackId: `track:${shotId}:dialogue:${lineId}`,
	};
};

const findShot = (project: UndoableState, shotId: string): Shot => {
	const shot = (project.shots ?? []).find((entry) => {
		return entry.id === shotId;
	});
	if (!shot) {
		throw domainInvariant(`Shot ${shotId} does not exist`, {shotId});
	}

	return shot;
};

const assertLine = (project: UndoableState, line: DialogueLineInput) => {
	const shot = findShot(project, line.shotId);
	if (
		!Number.isInteger(line.from) ||
		line.from < 0 ||
		!Number.isInteger(line.durationInFrames) ||
		line.durationInFrames < 1
	) {
		throw domainInvariant('Dialogue timing must use positive integer frames', {
			shotId: line.shotId,
			itemId: dialogueIds(line.shotId, line.lineId).itemId,
		});
	}

	const shotEnd = shot.from + shot.durationInFrames;
	if (line.from < shot.from || line.from + line.durationInFrames > shotEnd) {
		throw domainInvariant(
			`Dialogue ${line.lineId} falls outside shot ${line.shotId}`,
			{
				shotId: line.shotId,
				itemId: dialogueIds(line.shotId, line.lineId).itemId,
			},
		);
	}
};

const writeLine = (
	project: UndoableState,
	line: DialogueLineInput,
): UndoableState => {
	const shot = findShot(project, line.shotId);
	const ids = dialogueIds(line.shotId, line.lineId);
	if (
		project.assets[ids.assetId] === undefined &&
		Object.keys(project.assets).length >= MAX_ASSETS
	) {
		throw domainInvariant(`Asset count cannot exceed ${MAX_ASSETS}`, {
			shotId: line.shotId,
			assetId: ids.assetId,
		});
	}

	if (
		project.items[ids.itemId] === undefined &&
		Object.keys(project.items).length >= MAX_ITEMS
	) {
		throw domainInvariant(`Item count cannot exceed ${MAX_ITEMS}`, {
			shotId: line.shotId,
			itemId: ids.itemId,
		});
	}

	const durationMs = Math.max(
		1,
		Math.round((line.durationInFrames / project.fps) * 1000),
	);
	const builtAsset = buildCaptionAsset([
		{
			text: line.text,
			startMs: 0,
			endMs: durationMs,
			timestampMs: 0,
			confidence: 1,
		},
	]);
	const asset: CaptionAsset = {
		...builtAsset,
		id: ids.assetId,
		filename: `${line.lineId}.json`,
	};
	const builtItem = buildCaptionsItem({
		asset,
		fromFrame: line.from,
		fps: project.fps,
		compositionWidth: project.compositionWidth,
		compositionHeight: project.compositionHeight,
	});
	const voiceMetadata = resolveVoiceProfileMetadata(project, line);
	const item = {
		...builtItem,
		id: ids.itemId,
		from: line.from,
		durationInFrames: line.durationInFrames,
		lineId: line.lineId,
		shotId: line.shotId,
		...(voiceMetadata.characterId
			? {characterId: voiceMetadata.characterId}
			: {}),
		...(voiceMetadata.voiceProfileId
			? {voiceProfileId: voiceMetadata.voiceProfileId}
			: {}),
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
					items: [item.id],
					shotId: line.shotId,
					semantic: 'dialogue' as const,
					name: line.lineId,
					hidden: line.visible === false,
				};
			})
		: [
				...project.tracks,
				{
					id: ids.trackId,
					items: [item.id],
					hidden: line.visible === false,
					muted: false,
					name: line.lineId,
					shotId: line.shotId,
					semantic: 'dialogue' as const,
				},
			];
	const dialogueItemIds = shot.dialogueItemIds.includes(item.id)
		? shot.dialogueItemIds
		: [...shot.dialogueItemIds, item.id];

	return {
		...project,
		tracks,
		items: {
			...project.items,
			[item.id]: item,
		},
		assets: {
			...project.assets,
			[asset.id]: asset,
		},
		shots: (project.shots ?? []).map((entry) => {
			if (entry.id !== shot.id) {
				return entry;
			}

			return {
				...entry,
				dialogueItemIds,
			};
		}),
	};
};

export const addDialogue = (
	project: UndoableState,
	input: AddDialogueInput,
): UndoableState => {
	if (input.lines.length === 0) {
		throw domainInvariant('At least one dialogue line is required');
	}

	for (const line of input.lines) {
		assertLine(project, line);
	}

	return input.lines.reduce((current, line) => {
		return writeLine(current, line);
	}, cloneUndoableState(project));
};
