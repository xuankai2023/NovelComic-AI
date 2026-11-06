import {EditorStarterAsset} from '../assets/assets';
import {
	MAX_BATCH_SECONDS,
	MIN_BATCH_SECONDS,
	batchDurationFrames,
} from '../comic/limits';
import type {Shot} from '../comic/types';
import {propertyGraphSchema} from '../compose/schemas';
import type {AdvancedProjectState} from '../composition/types';
import {DEFAULT_FPS} from '../constants';
import {EditorStarterItem} from '../items/item-type';
import {
	validateSpriteReferences,
	validateTransformAnimation,
} from '../motion/diagnostics';
import {validatePropertyGraph} from '../property/evaluate-property';
import {TrackType} from '../state/types';
import {getCompositionDuration} from '../utils/get-composition-duration';
import {RenderVideoPayload} from './types';

const MIN_RENDER_FPS = 1;
const MAX_RENDER_FPS = 120;
const MAX_RENDER_DIMENSION = 7680;
const MAX_RENDER_DURATION_IN_SECONDS = 60 * 60;

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isFinitePositiveNumber = (value: unknown): value is number => {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
};

const isValidDimension = (value: unknown): value is number => {
	return (
		Number.isInteger(value) &&
		isFinitePositiveNumber(value) &&
		value <= MAX_RENDER_DIMENSION
	);
};

const getAssetId = (item: EditorStarterItem): string | null => {
	return 'assetId' in item ? item.assetId : null;
};

const parseShots = (value: unknown): Shot[] => {
	if (value === undefined) {
		return [];
	}

	if (!Array.isArray(value)) {
		throw new Error('shots must be an array');
	}

	const shots: Shot[] = [];
	const shotIds = new Set<string>();
	for (const [index, shot] of value.entries()) {
		if (
			!isRecord(shot) ||
			typeof shot.id !== 'string' ||
			shot.id.length === 0
		) {
			throw new Error(`shot at index ${index} is missing id`);
		}

		if (shotIds.has(shot.id)) {
			throw new Error(`duplicate shot id ${shot.id}`);
		}

		shotIds.add(shot.id);
		shots.push(shot as Shot);
	}

	return shots;
};

const assertMediaAssetReady = ({
	asset,
	item,
}: {
	asset: EditorStarterAsset | undefined;
	item: EditorStarterItem;
}) => {
	if (!asset) {
		throw new Error(`asset for item ${item.id} is missing`);
	}

	if (asset.type === 'caption') {
		if (!Array.isArray(asset.captions)) {
			throw new Error(`caption asset for item ${item.id} is invalid`);
		}
		return;
	}

	if (typeof asset.remoteUrl !== 'string' || asset.remoteUrl.length === 0) {
		throw new Error(`asset for item ${item.id} has no remoteUrl`);
	}
};

const parseFrameRange = (value: unknown): RenderVideoPayload['frameRange'] => {
	if (value === undefined) {
		return undefined;
	}

	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		!Number.isInteger(value[0]) ||
		!Number.isInteger(value[1])
	) {
		throw new Error('frameRange must be [startFrame, endFrameInclusive]');
	}

	const start = value[0];
	const end = value[1];
	if (start < 0 || end < 0) {
		throw new Error('frameRange cannot contain a negative frame');
	}

	if (end < start) {
		throw new Error('frameRange end is inclusive and must not precede start');
	}

	return [start, end];
};

const parseEnforceBatchDuration = (value: unknown): boolean | undefined => {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'boolean') {
		throw new Error('enforceBatchDuration must be a boolean');
	}

	return value;
};

const parseOptionalString = (
	value: unknown,
	label: string,
): string | undefined => {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
};

export const validateRenderMotion = (
	items: Record<string, EditorStarterItem>,
	assets: Record<string, EditorStarterAsset>,
): void => {
	for (const item of Object.values(items)) {
		if (item.type !== 'image') continue;
		const motionIssues = validateTransformAnimation({
			animation: item.motion?.transform,
			itemId: item.id,
			durationInFrames: item.durationInFrames,
		});
		if (motionIssues.length > 0) {
			const first = motionIssues[0]!;
			throw new Error(`${first.message}. ${first.repair}`);
		}
		const spriteIssues = validateSpriteReferences({item, assets});
		if (spriteIssues.length > 0) {
			const first = spriteIssues[0]!;
			throw new Error(`${first.message}. ${first.repair}`);
		}
	}
};

export const normalizeRenderFps = (fps: unknown): number => {
	if (fps === undefined) {
		return DEFAULT_FPS;
	}

	if (
		!Number.isFinite(fps) ||
		typeof fps !== 'number' ||
		fps < MIN_RENDER_FPS ||
		fps > MAX_RENDER_FPS
	) {
		throw new Error(
			`fps must be between ${MIN_RENDER_FPS} and ${MAX_RENDER_FPS}`,
		);
	}

	return fps;
};

export const validateRenderPayload = (value: unknown): RenderVideoPayload => {
	if (!isRecord(value)) {
		throw new Error('request body must be an object');
	}

	if (!isValidDimension(value.compositionHeight)) {
		throw new Error(
			`compositionHeight must be between 1 and ${MAX_RENDER_DIMENSION}`,
		);
	}

	if (!isValidDimension(value.compositionWidth)) {
		throw new Error(
			`compositionWidth must be between 1 and ${MAX_RENDER_DIMENSION}`,
		);
	}

	const fps = normalizeRenderFps(value.fps);

	if (!Array.isArray(value.tracks)) {
		throw new Error('tracks is not an array');
	}

	if (!isRecord(value.items)) {
		throw new Error('items must be an object');
	}

	if (!isRecord(value.assets)) {
		throw new Error('assets must be an object');
	}

	const items = value.items as Record<string, EditorStarterItem>;
	const assets = value.assets as Record<string, EditorStarterAsset>;
	const tracks = value.tracks as TrackType[];
	const shots = parseShots(value.shots);
	const propertyGraph =
		value.propertyGraph === undefined
			? undefined
			: propertyGraphSchema.parse(value.propertyGraph);
	const advanced = isRecord(value.advanced)
		? (value.advanced as AdvancedProjectState)
		: undefined;
	if (propertyGraph) {
		validatePropertyGraph({graph: propertyGraph, items, shots, advanced});
	}
	const shotIds = new Set(shots.map((itemShot) => itemShot.id));
	const itemValues = Object.values(items);

	if (itemValues.length === 0) {
		throw new Error('render must contain at least one item');
	}

	for (const item of itemValues) {
		if (typeof item.id !== 'string' || item.id.length === 0) {
			throw new Error('item id is missing');
		}

		if (!Number.isFinite(item.from) || item.from < 0) {
			throw new Error(`item ${item.id} has invalid from`);
		}

		if (!isFinitePositiveNumber(item.durationInFrames)) {
			throw new Error(`item ${item.id} has invalid durationInFrames`);
		}

		if (item.durationInFrames / fps > MAX_RENDER_DURATION_IN_SECONDS) {
			throw new Error(
				`item ${item.id} exceeds ${MAX_RENDER_DURATION_IN_SECONDS} seconds`,
			);
		}

		const assetId = getAssetId(item);
		if (assetId) {
			assertMediaAssetReady({
				asset: assets[assetId],
				item,
			});
		}

		if (item.type === 'image') {
			if (item.shotId && !shotIds.has(item.shotId)) {
				throw new Error(
					`item ${item.id} references missing shot ${item.shotId}`,
				);
			}

			for (const sprite of item.motion?.spriteStates ?? []) {
				assertMediaAssetReady({
					asset: assets[sprite.assetId],
					item,
				});
			}
			const motionIssues = validateTransformAnimation({
				animation: item.motion?.transform,
				itemId: item.id,
				durationInFrames: item.durationInFrames,
			});
			if (motionIssues.length > 0) {
				const first = motionIssues[0]!;
				throw new Error(`${first.message}. ${first.repair}`);
			}
			const spriteIssues = validateSpriteReferences({item, assets});
			if (spriteIssues.length > 0) {
				const first = spriteIssues[0]!;
				throw new Error(`${first.message}. ${first.repair}`);
			}
		}
	}

	const compositionHeight = value.compositionHeight;
	const compositionWidth = value.compositionWidth;
	const frameRange = parseFrameRange(value.frameRange);
	const enforceBatchDuration = parseEnforceBatchDuration(
		value.enforceBatchDuration,
	);
	const projectId = parseOptionalString(value.projectId, 'projectId');
	const inputSnapshotId = parseOptionalString(
		value.inputSnapshotId,
		'inputSnapshotId',
	);
	const inputContentHash = parseOptionalString(
		value.inputContentHash,
		'inputContentHash',
	);
	const preflightHash = parseOptionalString(value.preflightHash, 'preflightHash');
	if (value.warningsConfirmed !== undefined && typeof value.warningsConfirmed !== 'boolean') {
		throw new Error('warningsConfirmed must be a boolean');
	}
	const warningsConfirmed = value.warningsConfirmed as boolean | undefined;
	const traceabilityCount = [
		projectId,
		inputSnapshotId,
		inputContentHash,
		preflightHash,
	].filter(Boolean).length;
	if (traceabilityCount > 0 && traceabilityCount < 4) {
		throw new Error(
			'projectId, inputSnapshotId, inputContentHash and preflightHash must be provided together',
		);
	}
	const compositionDuration = getCompositionDuration(itemValues);
	if (frameRange) {
		const [start, end] = frameRange;
		if (start >= compositionDuration || end >= compositionDuration) {
			throw new Error('frameRange falls outside the project');
		}
	}

	if (enforceBatchDuration) {
		const renderedFrames = frameRange
			? frameRange[1] - frameRange[0] + 1
			: compositionDuration;
		const limits = batchDurationFrames(fps);
		if (renderedFrames < limits.min || renderedFrames > limits.max) {
			throw new Error(
				`batch duration must be between ${MIN_BATCH_SECONDS} and ${MAX_BATCH_SECONDS} seconds`,
			);
		}
	}

	return {
		compositionHeight,
		compositionWidth,
		fps,
		tracks,
		items,
		assets,
		shots,
		...(propertyGraph ? {propertyGraph} : {}),
		...(advanced ? {advanced} : {}),
		codec: value.codec as RenderVideoPayload['codec'],
		...(frameRange ? {frameRange} : {}),
		...(enforceBatchDuration !== undefined ? {enforceBatchDuration} : {}),
		...(projectId ? {projectId} : {}),
		...(inputSnapshotId ? {inputSnapshotId} : {}),
		...(inputContentHash ? {inputContentHash} : {}),
		...(preflightHash ? {preflightHash} : {}),
		...(warningsConfirmed !== undefined ? {warningsConfirmed} : {}),
	};
};
