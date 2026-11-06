import type {ImageItem} from '../items/image/image-item-type';
import type {SpriteState} from '../motion/types';
import type {UndoableState} from '../state/types';
import {
	buildBlinkSpriteStates,
	buildMouthFlapSpriteStates,
	type PhonemeMouthCue,
} from './build-sprite-motion';
import {domainInvariant} from './errors';
import {MAX_KEYFRAMES_PER_ITEM} from './limits';
import {cloneUndoableState} from './upsert-shot';
import {assertFinalMotionTarget} from './assert-motion-target';

export type ApplySpriteMotionMode = 'replace' | 'append';

export type SpriteMotionInput =
	| {
			kind: 'blink';
			openAssetId: string;
			closedAssetId: string;
			seed: number;
	  }
	| {
			kind: 'mouth-flap';
			closedAssetId: string;
			halfAssetId?: string;
			openAssetId: string;
			dialogueItemIds?: string[];
			phonemeCues?: PhonemeMouthCue[];
	  };

export type ApplySpriteMotionInput = {
	itemId: string;
	mode: ApplySpriteMotionMode;
	sprite: SpriteMotionInput;
};

const requireImageItem = (
	project: UndoableState,
	itemId: string,
): ImageItem => {
	const item = project.items[itemId];
	if (!item || item.type !== 'image') {
		throw domainInvariant(`Item ${itemId} is not an image`, {itemId});
	}

	return item;
};

const requireImageAsset = (
	project: UndoableState,
	itemId: string,
	assetId: string,
): void => {
	const asset = project.assets[assetId];
	if (!asset || asset.type !== 'image') {
		throw domainInvariant(`Sprite asset ${assetId} is not an image`, {
			itemId,
			assetId,
		});
	}
};

const dialogueRanges = (
	project: UndoableState,
	item: ImageItem,
	dialogueItemIds: readonly string[],
): Array<{from: number; durationInFrames: number}> => {
	if (dialogueItemIds.length === 0) {
		throw domainInvariant('Mouth flap requires at least one dialogue item', {
			itemId: item.id,
		});
	}

	return dialogueItemIds.map((dialogueItemId) => {
		const dialogue = project.items[dialogueItemId];
		if (!dialogue || dialogue.type !== 'captions') {
			throw domainInvariant(
				`Dialogue item ${dialogueItemId} is not a caption`,
				{itemId: dialogueItemId},
			);
		}

		return {
			from: dialogue.from - item.from,
			durationInFrames: dialogue.durationInFrames,
		};
	});
};

const mergeStates = (
	existing: readonly SpriteState[],
	incoming: readonly SpriteState[],
	mode: ApplySpriteMotionMode,
	itemId: string,
): SpriteState[] => {
	if (mode === 'replace') {
		return incoming.map((state) => ({...state}));
	}

	const byFrame = new Map<number, SpriteState>();
	for (const state of existing) {
		byFrame.set(state.frame, {...state});
	}

	for (const state of incoming) {
		const current = byFrame.get(state.frame);
		if (current && current.assetId !== state.assetId) {
			throw domainInvariant(
				`Sprite state frame ${state.frame} conflicts with existing motion`,
				{itemId},
			);
		}

		byFrame.set(state.frame, {...state});
	}

	return [...byFrame.values()].sort((left, right) => {
		return left.frame - right.frame;
	});
};

export const applySpriteMotion = (
	project: UndoableState,
	input: ApplySpriteMotionInput,
): UndoableState => {
	const draft = cloneUndoableState(project);
	const item = requireImageItem(draft, input.itemId);
	assertFinalMotionTarget(draft, item);
	let incoming: SpriteState[];
	let spriteAssetIds: string[];

	if (input.sprite.kind === 'blink') {
		spriteAssetIds = [input.sprite.openAssetId, input.sprite.closedAssetId];
		for (const assetId of spriteAssetIds) {
			requireImageAsset(draft, item.id, assetId);
		}

		incoming = buildBlinkSpriteStates({
			openAssetId: input.sprite.openAssetId,
			closedAssetId: input.sprite.closedAssetId,
			seed: input.sprite.seed,
			durationInFrames: item.durationInFrames,
			fps: draft.fps,
		});
	} else {
		spriteAssetIds = [
			input.sprite.closedAssetId,
			input.sprite.halfAssetId,
			input.sprite.openAssetId,
		].filter((assetId): assetId is string => Boolean(assetId));
		for (const assetId of spriteAssetIds) {
			requireImageAsset(draft, item.id, assetId);
		}

		const hasPhonemeCues = (input.sprite.phonemeCues?.length ?? 0) > 0;
		incoming = buildMouthFlapSpriteStates({
			assetIds: {
				closed: input.sprite.closedAssetId,
				half: input.sprite.halfAssetId,
				open: input.sprite.openAssetId,
			},
			dialogueRanges: hasPhonemeCues
				? []
				: dialogueRanges(draft, item, input.sprite.dialogueItemIds ?? []),
			phonemeCues: input.sprite.phonemeCues,
			durationInFrames: item.durationInFrames,
			fps: draft.fps,
		});
	}

	const spriteStates = mergeStates(
		item.motion?.spriteStates ?? [],
		incoming,
		input.mode,
		item.id,
	);
	if (spriteStates.length > MAX_KEYFRAMES_PER_ITEM) {
		throw domainInvariant(
			`Sprite state count cannot exceed ${MAX_KEYFRAMES_PER_ITEM}`,
			{itemId: item.id},
		);
	}

	return {
		...draft,
		items: {
			...draft.items,
			[item.id]: {
				...item,
				spriteAssetIds: [
					...new Set([...(item.spriteAssetIds ?? []), ...spriteAssetIds]),
				],
				motion: {
					...item.motion,
					spriteStates,
				},
			},
		},
	};
};
