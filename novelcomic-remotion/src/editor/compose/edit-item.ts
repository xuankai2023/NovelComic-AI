import {domainInvariant} from '../comic/errors';
import {assertItemsDetachable} from '../comic/shot-owned-item';
import {
	IMAGE_BLEND_MODES,
	IMAGE_MASK_MODES,
	type ImageBlendMode,
	type ImageMaskMode,
} from '../items/image/image-item-type';
import type {EditorStarterItem} from '../items/item-type';
import type {ImageMotion} from '../motion/types';
import {writeItemTransformPropertySet} from '../property/materialize-motion';
import type {UndoableState} from '../state/types';
import {imageMotionSchema} from './schemas';

export type ItemEditPatch = {
	fromMs?: number;
	durationMs?: number;
	sourceStartMs?: number;
	decibelAdjustment?: number;
	audioFadeInMs?: number;
	audioFadeOutMs?: number;
	fadeInMs?: number;
	fadeOutMs?: number;
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	opacity?: number;
	rotation?: number;
	cropLeft?: number;
	cropTop?: number;
	cropRight?: number;
	cropBottom?: number;
	motion?: ImageMotion | null;
	blendMode?: ImageBlendMode | null;
	maskAssetId?: string | null;
	maskMode?: ImageMaskMode | null;
};

const msToFrame = (ms: number, fps: number) => Math.round((ms / 1000) * fps);

const assertFinite = (value: number, field: string) => {
	if (!Number.isFinite(value)) {
		throw new Error(`${field} must be a finite number`);
	}
};

const withField = <T extends EditorStarterItem>(
	item: T,
	patch: Partial<T>,
): T => {
	return {
		...item,
		...patch,
	};
};

export const editItem = ({
	project,
	itemId,
	patch,
}: {
	project: UndoableState;
	itemId: string;
	patch: ItemEditPatch;
}): {project: UndoableState; item: EditorStarterItem} => {
	const item = project.items[itemId];
	if (!item) {
		throw new Error(`item ${itemId} not found`);
	}

	const timingTouched =
		patch.fromMs !== undefined ||
		patch.durationMs !== undefined ||
		patch.sourceStartMs !== undefined;
	if (timingTouched) {
		assertItemsDetachable(project, [itemId]);
	}

	let next: EditorStarterItem = item;
	const fps = project.fps;

	if (patch.fromMs !== undefined) {
		assertFinite(patch.fromMs, 'patch.fromMs');
		if (patch.fromMs < 0) {
			throw new Error('patch.fromMs cannot be negative');
		}
		next = {...next, from: msToFrame(patch.fromMs, fps)};
	}

	if (patch.durationMs !== undefined) {
		assertFinite(patch.durationMs, 'patch.durationMs');
		if (patch.durationMs <= 0) {
			throw new Error('patch.durationMs must be greater than 0');
		}
		next = {
			...next,
			durationInFrames: Math.max(1, msToFrame(patch.durationMs, fps)),
		};
	}

	if (patch.sourceStartMs !== undefined) {
		assertFinite(patch.sourceStartMs, 'patch.sourceStartMs');
		if (patch.sourceStartMs < 0) {
			throw new Error('patch.sourceStartMs cannot be negative');
		}
		const sourceStartInSeconds = patch.sourceStartMs / 1000;
		if (next.type === 'video') {
			next = {...next, videoStartFromInSeconds: sourceStartInSeconds};
		} else if (next.type === 'audio') {
			next = {...next, audioStartFromInSeconds: sourceStartInSeconds};
		} else if (next.type === 'gif') {
			next = {...next, gifStartFromInSeconds: sourceStartInSeconds};
		} else if (next.type === 'captions') {
			next = {...next, captionStartInSeconds: sourceStartInSeconds};
		} else {
			throw new Error(`sourceStartMs is not supported for ${next.type} items`);
		}
	}

	if (patch.decibelAdjustment !== undefined) {
		assertFinite(patch.decibelAdjustment, 'patch.decibelAdjustment');
		if (next.type !== 'video' && next.type !== 'audio') {
			throw new Error(
				`decibelAdjustment is not supported for ${next.type} items`,
			);
		}
		next = {...next, decibelAdjustment: patch.decibelAdjustment};
	}

	if (patch.audioFadeInMs !== undefined) {
		assertFinite(patch.audioFadeInMs, 'patch.audioFadeInMs');
		if (patch.audioFadeInMs < 0) {
			throw new Error('patch.audioFadeInMs cannot be negative');
		}
		if (next.type !== 'video' && next.type !== 'audio') {
			throw new Error(`audioFadeInMs is not supported for ${next.type} items`);
		}
		next = {
			...next,
			audioFadeInDurationInSeconds: patch.audioFadeInMs / 1000,
		};
	}

	if (patch.audioFadeOutMs !== undefined) {
		assertFinite(patch.audioFadeOutMs, 'patch.audioFadeOutMs');
		if (patch.audioFadeOutMs < 0) {
			throw new Error('patch.audioFadeOutMs cannot be negative');
		}
		if (next.type !== 'video' && next.type !== 'audio') {
			throw new Error(`audioFadeOutMs is not supported for ${next.type} items`);
		}
		next = {
			...next,
			audioFadeOutDurationInSeconds: patch.audioFadeOutMs / 1000,
		};
	}

	if (patch.fadeInMs !== undefined) {
		assertFinite(patch.fadeInMs, 'patch.fadeInMs');
		if (patch.fadeInMs < 0) {
			throw new Error('patch.fadeInMs cannot be negative');
		}
		if (!('fadeInDurationInSeconds' in next)) {
			throw new Error(`fadeInMs is not supported for ${next.type} items`);
		}
		next = {...next, fadeInDurationInSeconds: patch.fadeInMs / 1000};
	}

	if (patch.fadeOutMs !== undefined) {
		assertFinite(patch.fadeOutMs, 'patch.fadeOutMs');
		if (patch.fadeOutMs < 0) {
			throw new Error('patch.fadeOutMs cannot be negative');
		}
		if (!('fadeOutDurationInSeconds' in next)) {
			throw new Error(`fadeOutMs is not supported for ${next.type} items`);
		}
		next = {...next, fadeOutDurationInSeconds: patch.fadeOutMs / 1000};
	}

	if (patch.left !== undefined) {
		assertFinite(patch.left, 'patch.left');
		next = withField(next, {left: patch.left});
	}

	if (patch.top !== undefined) {
		assertFinite(patch.top, 'patch.top');
		next = withField(next, {top: patch.top});
	}

	if (patch.width !== undefined) {
		assertFinite(patch.width, 'patch.width');
		if (patch.width <= 0) {
			throw new Error('patch.width must be greater than 0');
		}
		next = withField(next, {width: patch.width});
	}

	if (patch.height !== undefined) {
		assertFinite(patch.height, 'patch.height');
		if (patch.height <= 0) {
			throw new Error('patch.height must be greater than 0');
		}
		next = withField(next, {height: patch.height});
	}

	if (patch.opacity !== undefined) {
		assertFinite(patch.opacity, 'patch.opacity');
		if (patch.opacity < 0 || patch.opacity > 1) {
			throw new Error('patch.opacity must be between 0 and 1');
		}
		next = withField(next, {opacity: patch.opacity});
	}

	if (patch.rotation !== undefined) {
		assertFinite(patch.rotation, 'patch.rotation');
		if (!('rotation' in next)) {
			throw new Error(`rotation is not supported for ${next.type} items`);
		}
		next = {...next, rotation: patch.rotation};
	}

	const cropPatch = {
		cropLeft: patch.cropLeft,
		cropTop: patch.cropTop,
		cropRight: patch.cropRight,
		cropBottom: patch.cropBottom,
	};
	for (const [field, value] of Object.entries(cropPatch)) {
		if (value === undefined) {
			continue;
		}

		assertFinite(value, `patch.${field}`);
		if (!('cropLeft' in next)) {
			throw new Error(`crop is not supported for ${next.type} items`);
		}
	}

	if ('cropLeft' in next) {
		next = {
			...next,
			cropLeft: patch.cropLeft ?? next.cropLeft,
			cropTop: patch.cropTop ?? next.cropTop,
			cropRight: patch.cropRight ?? next.cropRight,
			cropBottom: patch.cropBottom ?? next.cropBottom,
		};
	}

	if (patch.motion !== undefined) {
		if (next.type !== 'image') {
			throw domainInvariant('Motion can only be written to image items', {
				itemId: next.id,
			});
		}

		if (patch.motion === null) {
			const nextItem = {...next};
			delete nextItem.motion;
			next = nextItem;
		} else {
			next = {
				...next,
				motion: imageMotionSchema.parse(patch.motion),
			};
		}
	}

	if (patch.blendMode !== undefined) {
		if (next.type !== 'image') {
			throw domainInvariant('Blend mode can only be written to image items', {
				itemId: next.id,
			});
		}

		if (
			patch.blendMode !== null &&
			!(IMAGE_BLEND_MODES as readonly string[]).includes(patch.blendMode)
		) {
			throw new Error(`Unknown image blend mode: ${patch.blendMode}`);
		}

		if (patch.blendMode === null || patch.blendMode === 'normal') {
			const nextItem = {...next};
			delete nextItem.blendMode;
			next = nextItem;
		} else {
			next = {...next, blendMode: patch.blendMode};
		}
	}

	if (patch.maskAssetId !== undefined) {
		if (next.type !== 'image') {
			throw domainInvariant('Mask can only be written to image items', {
				itemId: next.id,
			});
		}

		if (patch.maskAssetId !== null && patch.maskAssetId.trim() === '') {
			throw new Error('patch.maskAssetId cannot be empty');
		}

		if (patch.maskAssetId === null) {
			const nextItem = {...next};
			delete nextItem.maskAssetId;
			delete nextItem.maskMode;
			next = nextItem;
		} else {
			next = {...next, maskAssetId: patch.maskAssetId};
		}
	}

	if (patch.maskMode !== undefined) {
		if (next.type !== 'image') {
			throw domainInvariant('Mask mode can only be written to image items', {
				itemId: next.id,
			});
		}

		if (
			patch.maskMode !== null &&
			!(IMAGE_MASK_MODES as readonly string[]).includes(patch.maskMode)
		) {
			throw new Error(`Unknown image mask mode: ${patch.maskMode}`);
		}

		if (patch.maskMode === null) {
			const nextItem = {...next};
			delete nextItem.maskMode;
			next = nextItem;
		} else {
			next = {...next, maskMode: patch.maskMode};
		}
	}

	const updatedProject = {
		...project,
		items: {
			...project.items,
			[next.id]: next,
		},
	};
	return {
		item: next,
		project:
			patch.motion !== undefined && next.type === 'image'
				? writeItemTransformPropertySet(
						updatedProject,
						next.id,
						next.motion?.transform,
					)
				: updatedProject,
	};
};
