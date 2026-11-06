import type {EditorStarterAsset} from '../assets/assets';
import {findUnsafeRemoteUrlReason} from '../compose/validate-remote-url';
import {
	IMAGE_BLEND_MODES,
	IMAGE_MASK_MODES,
} from '../items/image/image-item-type';
import type {EditorStarterItem} from '../items/item-type';
import {validateTrackMattes} from '../masks/track-matte';
import {validateTransformAnimation} from '../motion/diagnostics';
import {
	CAMERA_PRESET_IDS,
	ITEM_PRESET_IDS,
	SPRITE_PRESET_IDS,
} from '../motion/presets';
import {EASING_NAMES, TRANSFORM_LOOPS} from '../motion/types';
import type {UndoableState} from '../state/types';
import {COMIC_SCHEMA_VERSION} from './limits';
import {VOICE_PROFILE_PROVIDERS, type ProjectIssue, type Shot} from './types';
import {validateManualLayerBounds} from './validate-layer-bounds';
import {validateMotionExposureForProject} from './validate-motion-exposure';

const KNOWN_PRESET_IDS = new Set<string>([
	...CAMERA_PRESET_IDS,
	...ITEM_PRESET_IDS,
	...SPRITE_PRESET_IDS,
]);

const getItemAssetId = (item: EditorStarterItem): string | null => {
	if ('assetId' in item) {
		return item.assetId;
	}

	return null;
};

const getSourceStartMs = (item: EditorStarterItem): number | null => {
	if (item.type === 'video') {
		return Math.round(item.videoStartFromInSeconds * 1000);
	}

	if (item.type === 'audio') {
		return Math.round(item.audioStartFromInSeconds * 1000);
	}

	if (item.type === 'gif') {
		return Math.round(item.gifStartFromInSeconds * 1000);
	}

	if (item.type === 'captions') {
		return Math.round(item.captionStartInSeconds * 1000);
	}

	return null;
};

const getAssetDurationInSeconds = (
	asset: EditorStarterAsset | undefined,
): number | null => {
	if (
		asset?.type === 'video' ||
		asset?.type === 'audio' ||
		asset?.type === 'gif'
	) {
		return asset.durationInSeconds;
	}

	return null;
};

const issue = (
	severity: ProjectIssue['severity'],
	code: string,
	message: string,
	ids?: Partial<
		Pick<ProjectIssue, 'shotId' | 'trackId' | 'itemId' | 'assetId'>
	>,
): ProjectIssue => {
	const next: ProjectIssue = {severity, code, message};
	if (ids?.shotId !== undefined) {
		next.shotId = ids.shotId;
	}

	if (ids?.trackId !== undefined) {
		next.trackId = ids.trackId;
	}

	if (ids?.itemId !== undefined) {
		next.itemId = ids.itemId;
	}

	if (ids?.assetId !== undefined) {
		next.assetId = ids.assetId;
	}

	return next;
};

const isKnownEasing = (value: string): boolean => {
	return (EASING_NAMES as readonly string[]).includes(value);
};

const isKnownLoop = (value: string): boolean => {
	return (TRANSFORM_LOOPS as readonly string[]).includes(value);
};

const validateNumericKeyframe = (
	keyframe: {
		frame: number;
		easing?: string;
		scale?: number;
		opacity?: number;
	},
	durationInFrames: number,
	label: string,
	ids: Partial<Pick<ProjectIssue, 'shotId' | 'itemId'>>,
	issues: ProjectIssue[],
) => {
	if (
		!Number.isInteger(keyframe.frame) ||
		keyframe.frame < 0 ||
		keyframe.frame >= durationInFrames
	) {
		issues.push(
			issue(
				'error',
				'INVALID_MOTION',
				`${label} keyframe frame must lie inside the duration`,
				ids,
			),
		);
	}

	if (keyframe.easing !== undefined && !isKnownEasing(keyframe.easing)) {
		issues.push(
			issue('error', 'INVALID_MOTION', `${label} easing is invalid`, ids),
		);
	}

	if (
		keyframe.scale !== undefined &&
		(!Number.isFinite(keyframe.scale) || keyframe.scale <= 0)
	) {
		issues.push(
			issue('error', 'INVALID_MOTION', `${label} scale must be positive`, ids),
		);
	}

	if (
		keyframe.opacity !== undefined &&
		(!Number.isFinite(keyframe.opacity) || keyframe.opacity < 0)
	) {
		issues.push(
			issue(
				'error',
				'INVALID_MOTION',
				`${label} opacity must be finite and non-negative`,
				ids,
			),
		);
	}
};

const validateLoop = (
	animation: {
		loop?: string;
		loopStartFrame?: number;
		loopEndFrame?: number;
	},
	label: string,
	ids: Partial<Pick<ProjectIssue, 'shotId' | 'itemId'>>,
	issues: ProjectIssue[],
) => {
	if (animation.loop === undefined || animation.loop === 'none') {
		return;
	}

	if (!isKnownLoop(animation.loop)) {
		issues.push(
			issue('error', 'INVALID_MOTION', `${label} loop is invalid`, ids),
		);
		return;
	}

	if (
		animation.loopStartFrame === undefined ||
		animation.loopEndFrame === undefined ||
		!Number.isInteger(animation.loopStartFrame) ||
		!Number.isInteger(animation.loopEndFrame) ||
		animation.loopEndFrame < animation.loopStartFrame
	) {
		issues.push(
			issue('error', 'INVALID_MOTION', `${label} loop window is invalid`, ids),
		);
	}
};

const validateShotTiming = (shots: readonly Shot[], issues: ProjectIssue[]) => {
	const seen = new Set<string>();
	for (let index = 0; index < shots.length; index++) {
		const shot = shots[index];
		if (seen.has(shot.id)) {
			issues.push(
				issue('error', 'DUPLICATE_SHOT', `Shot ${shot.id} is duplicated`, {
					shotId: shot.id,
				}),
			);
		}

		seen.add(shot.id);
		if (!Number.isInteger(shot.from) || shot.from < 0) {
			issues.push(
				issue('error', 'SHOT_TIMING', `Shot ${shot.id} has an invalid start`, {
					shotId: shot.id,
				}),
			);
		}

		if (!Number.isInteger(shot.durationInFrames) || shot.durationInFrames < 1) {
			issues.push(
				issue(
					'error',
					'SHOT_TIMING',
					`Shot ${shot.id} duration must be a positive integer`,
					{shotId: shot.id},
				),
			);
		}

		const previous = shots[index - 1];
		if (!previous) {
			continue;
		}

		if (shot.from < previous.from) {
			issues.push(
				issue('error', 'SHOT_ORDER', 'Shots must be ordered by start frame', {
					shotId: shot.id,
				}),
			);
		}

		const overlap =
			previous.transitionOut?.type === 'crossfade'
				? previous.transitionOut.durationInFrames
				: 0;
		if (previous.transitionOut?.type === 'crossfade') {
			if (
				!Number.isInteger(overlap) ||
				overlap < 1 ||
				overlap >= previous.durationInFrames ||
				overlap >= shot.durationInFrames
			) {
				issues.push(
					issue(
						'error',
						'CROSSFADE_RANGE',
						`Crossfade on shot ${previous.id} must be shorter than both shots`,
						{shotId: previous.id},
					),
				);
			}
		}

		const expectedFrom =
			previous.from + previous.durationInFrames - (overlap > 0 ? overlap : 0);
		if (shot.from < expectedFrom) {
			issues.push(
				issue(
					'error',
					'SHOT_OVERLAP',
					`Shot ${shot.id} overlaps ${previous.id} outside its transition`,
					{shotId: shot.id},
				),
			);
		} else if (shot.from > expectedFrom) {
			issues.push(
				issue(
					'error',
					'SHOT_GAP',
					`Shot ${shot.id} leaves a gap after ${previous.id}`,
					{shotId: shot.id},
				),
			);
		}
	}
};

const validateShotLinks = (project: UndoableState, issues: ProjectIssue[]) => {
	const shots = project.shots ?? [];
	const shotById = new Map(
		shots.map((shot) => {
			return [shot.id, shot];
		}),
	);

	for (const shot of shots) {
		if (shot.cameraMotion) {
			validateLoop(shot.cameraMotion, 'Camera', {shotId: shot.id}, issues);
			for (const keyframe of shot.cameraMotion.keyframes) {
				validateNumericKeyframe(
					keyframe,
					shot.durationInFrames,
					'Camera',
					{shotId: shot.id},
					issues,
				);
			}
		}

		for (const trackId of shot.layerTrackIds) {
			const track = project.tracks.find((entry) => {
				return entry.id === trackId;
			});
			if (!track) {
				issues.push(
					issue(
						'error',
						'MISSING_TRACK',
						`Shot ${shot.id} references missing track ${trackId}`,
						{shotId: shot.id, trackId},
					),
				);
				continue;
			}

			for (const itemId of track.items) {
				const item = project.items[itemId];
				if (!item) {
					continue;
				}

				if (
					item.from !== shot.from ||
					item.durationInFrames !== shot.durationInFrames
				) {
					issues.push(
						issue(
							'error',
							'SHOT_ITEM_TIMING',
							`Item ${item.id} must match shot ${shot.id}`,
							{shotId: shot.id, itemId: item.id, trackId},
						),
					);
				}
			}
		}

		const shotEnd = shot.from + shot.durationInFrames;
		for (const itemId of shot.dialogueItemIds) {
			const item = project.items[itemId];
			if (!item) {
				issues.push(
					issue(
						'error',
						'MISSING_ITEM',
						`Shot ${shot.id} references missing dialogue item ${itemId}`,
						{shotId: shot.id, itemId},
					),
				);
				continue;
			}

			if (item.type !== 'captions') {
				issues.push(
					issue(
						'error',
						'DIALOGUE_ITEM_TYPE',
						`Dialogue item ${item.id} must be a captions item`,
						{shotId: shot.id, itemId: item.id},
					),
				);
			}

			if (
				item.from < shot.from ||
				item.from + item.durationInFrames > shotEnd
			) {
				issues.push(
					issue(
						'error',
						'DIALOGUE_OUTSIDE_SHOT',
						`Dialogue item ${item.id} falls outside shot ${shot.id}`,
						{shotId: shot.id, itemId: item.id},
					),
				);
			}
		}
	}

	for (const track of project.tracks) {
		if (track.shotId && !shotById.has(track.shotId)) {
			issues.push(
				issue(
					'error',
					'MISSING_SHOT',
					`Track ${track.id} references missing shot ${track.shotId}`,
					{trackId: track.id, shotId: track.shotId},
				),
			);
		}
	}
};

const validateImageMotion = (
	project: UndoableState,
	issues: ProjectIssue[],
) => {
	const enforceRemoteSafety =
		(project.schemaVersion ?? 1) >= COMIC_SCHEMA_VERSION ||
		(project.shots?.length ?? 0) > 0;

	for (const item of Object.values(project.items)) {
		if (item.type !== 'image') {
			continue;
		}

		if (
			item.shotId &&
			!(project.shots ?? []).some((shot) => shot.id === item.shotId)
		) {
			issues.push(
				issue(
					'error',
					'MISSING_SHOT',
					`Item ${item.id} references missing shot ${item.shotId}`,
					{itemId: item.id, shotId: item.shotId},
				),
			);
		}

		const asset = project.assets[item.assetId];
		if (asset && asset.type !== 'image') {
			issues.push(
				issue(
					'error',
					'IMAGE_ASSET_TYPE',
					`Image item ${item.id} must reference an image asset`,
					{itemId: item.id, assetId: item.assetId},
				),
			);
		}

		if (
			item.blendMode !== undefined &&
			!(IMAGE_BLEND_MODES as readonly string[]).includes(item.blendMode)
		) {
			issues.push(
				issue(
					'error',
					'INVALID_BLEND_MODE',
					`Image item ${item.id} has an invalid blend mode`,
					{itemId: item.id},
				),
			);
		}

		if (
			item.maskMode !== undefined &&
			!(IMAGE_MASK_MODES as readonly string[]).includes(item.maskMode)
		) {
			issues.push(
				issue(
					'error',
					'INVALID_MASK_MODE',
					`Image item ${item.id} has an invalid mask mode`,
					{itemId: item.id},
				),
			);
		}

		if (item.maskAssetId) {
			const maskAsset = project.assets[item.maskAssetId];
			if (!maskAsset) {
				issues.push(
					issue(
						'error',
						'MISSING_MASK_ASSET',
						`Image item ${item.id} references missing mask asset ${item.maskAssetId}`,
						{itemId: item.id, assetId: item.maskAssetId},
					),
				);
			} else if (maskAsset.type !== 'image') {
				issues.push(
					issue(
						'error',
						'INVALID_MASK_ASSET_TYPE',
						`Mask asset ${maskAsset.id} must be an image`,
						{itemId: item.id, assetId: maskAsset.id},
					),
				);
			}
		}

		if (
			asset?.type === 'image' &&
			(!Number.isFinite(asset.width) ||
				asset.width < 1 ||
				!Number.isFinite(asset.height) ||
				asset.height < 1)
		) {
			issues.push(
				issue(
					'error',
					'INVALID_IMAGE_SIZE',
					`Image asset ${asset.id} has invalid dimensions`,
					{itemId: item.id, assetId: asset.id},
				),
			);
		}

		if (
			!Number.isFinite(item.opacity) ||
			item.opacity < 0 ||
			item.opacity > 1
		) {
			issues.push(
				issue(
					'error',
					'INVALID_IMAGE_OPACITY',
					`Image item ${item.id} opacity must be between 0 and 1`,
					{itemId: item.id},
				),
			);
		}

		if (enforceRemoteSafety && asset?.type === 'image' && asset.remoteUrl) {
			const reason = findUnsafeRemoteUrlReason(asset.remoteUrl);
			if (reason) {
				issues.push(
					issue('error', 'INVALID_REMOTE_URL', reason, {
						itemId: item.id,
						assetId: asset.id,
					}),
				);
			}
		}

		for (const spriteAssetId of item.spriteAssetIds ?? []) {
			const spriteAsset = project.assets[spriteAssetId];
			if (!spriteAsset) {
				issues.push(
					issue(
						'error',
						'MISSING_SPRITE_ASSET',
						`Item ${item.id} references missing sprite asset ${spriteAssetId}`,
						{itemId: item.id, assetId: spriteAssetId},
					),
				);
			} else if (spriteAsset.type !== 'image') {
				issues.push(
					issue(
						'error',
						'INVALID_SPRITE_ASSET_TYPE',
						`Sprite asset ${spriteAssetId} for item ${item.id} must be an image`,
						{itemId: item.id, assetId: spriteAssetId},
					),
				);
			}
		}

		const motion = item.motion;
		if (!motion) {
			continue;
		}

		if (motion.preset && !KNOWN_PRESET_IDS.has(motion.preset.id)) {
			issues.push(
				issue(
					'error',
					'INVALID_MOTION',
					`Unknown motion preset ${motion.preset.id}`,
					{itemId: item.id},
				),
			);
		}

		if ('transform' in motion && motion.transform !== undefined) {
			for (const diagnostic of validateTransformAnimation({
				animation: motion.transform,
				itemId: item.id,
				durationInFrames: item.durationInFrames,
			})) {
				issues.push({
					severity: 'error',
					code: diagnostic.code,
					message: diagnostic.message,
					suggestion: diagnostic.repair,
					itemId: item.id,
					...(diagnostic.assetId ? {assetId: diagnostic.assetId} : {}),
					...(diagnostic.frame !== undefined ? {frame: diagnostic.frame} : {}),
					...(diagnostic.property ? {property: diagnostic.property} : {}),
				});
			}
		}

		const seenSpriteFrames = new Set<number>();
		for (const sprite of motion.spriteStates ?? []) {
			if (
				!Number.isInteger(sprite.frame) ||
				sprite.frame < 0 ||
				sprite.frame >= item.durationInFrames
			) {
				issues.push(
					issue(
						'error',
						'INVALID_MOTION',
						`Sprite frame on item ${item.id} is invalid`,
						{itemId: item.id, assetId: sprite.assetId},
					),
				);
			}

			if (seenSpriteFrames.has(sprite.frame)) {
				issues.push(
					issue(
						'error',
						'INVALID_MOTION',
						`Sprite frame ${sprite.frame} is duplicated on item ${item.id}`,
						{itemId: item.id, assetId: sprite.assetId},
					),
				);
			}

			seenSpriteFrames.add(sprite.frame);
			const spriteAsset = project.assets[sprite.assetId];
			if (!spriteAsset) {
				issues.push(
					issue(
						'error',
						'MISSING_SPRITE_ASSET',
						`Item ${item.id} references missing sprite asset ${sprite.assetId}`,
						{itemId: item.id, assetId: sprite.assetId},
					),
				);
			} else if (spriteAsset.type !== 'image') {
				issues.push(
					issue(
						'error',
						'INVALID_SPRITE_ASSET_TYPE',
						`Sprite asset ${sprite.assetId} for item ${item.id} must be an image`,
						{itemId: item.id, assetId: sprite.assetId},
					),
				);
			}
		}
	}
};

const validateVoiceProfiles = (
	project: UndoableState,
	issues: ProjectIssue[],
) => {
	const knownProviders = new Set<string>(VOICE_PROFILE_PROVIDERS);
	const defaultByCharacter = new Set<string>();

	for (const [key, profile] of Object.entries(project.voiceProfiles ?? {})) {
		if (key !== profile.id) {
			issues.push(
				issue(
					'warning',
					'VOICE_PROFILE_KEY_MISMATCH',
					`Voice profile ${key} is stored under a different id ${profile.id}`,
				),
			);
		}

		if (!profile.id || !profile.characterId || !profile.voiceId) {
			issues.push(
				issue(
					'error',
					'INVALID_VOICE_PROFILE',
					`Voice profile ${profile.id || key} is missing required fields`,
				),
			);
		}

		if (!knownProviders.has(profile.provider)) {
			issues.push(
				issue(
					'error',
					'INVALID_VOICE_PROFILE',
					`Voice profile ${profile.id || key} has an invalid provider`,
				),
			);
		}

		if (!profile.defaultForCharacter || !profile.characterId) {
			continue;
		}

		if (defaultByCharacter.has(profile.characterId)) {
			issues.push(
				issue(
					'error',
					'VOICE_PROFILE_DEFAULT_CONFLICT',
					`Character ${profile.characterId} has more than one default voice profile`,
				),
			);
		}

		defaultByCharacter.add(profile.characterId);
	}

	for (const item of Object.values(project.items)) {
		if (item.type !== 'audio' && item.type !== 'captions') {
			continue;
		}

		if (!item.voiceProfileId) {
			continue;
		}

		const profile = project.voiceProfiles?.[item.voiceProfileId];
		if (!profile) {
			issues.push(
				issue(
					'error',
					'MISSING_VOICE_PROFILE',
					`Item ${item.id} references missing voice profile ${item.voiceProfileId}`,
					{itemId: item.id},
				),
			);
			continue;
		}

		if (item.characterId && profile.characterId !== item.characterId) {
			issues.push(
				issue(
					'error',
					'VOICE_PROFILE_CHARACTER_MISMATCH',
					`Item ${item.id} references a voice profile for another character`,
					{itemId: item.id},
				),
			);
		}
	}
};

export const validateProject = (project: UndoableState): ProjectIssue[] => {
	const issues: ProjectIssue[] = [];
	const referencedItemIds = new Set<string>();

	for (const track of project.tracks) {
		if (track.muted) {
			issues.push(
				issue('warning', 'TRACK_MUTED', `Track ${track.id} is muted`, {
					trackId: track.id,
				}),
			);
		}

		if (track.hidden) {
			issues.push(
				issue('warning', 'TRACK_HIDDEN', `Track ${track.id} is hidden`, {
					trackId: track.id,
				}),
			);
		}

		for (const itemId of track.items) {
			referencedItemIds.add(itemId);
			if (!project.items[itemId]) {
				issues.push(
					issue(
						'error',
						'MISSING_ITEM',
						`Track ${track.id} references missing item ${itemId}`,
						{trackId: track.id, itemId},
					),
				);
			}
		}
	}

	for (const item of Object.values(project.items)) {
		if (!referencedItemIds.has(item.id)) {
			issues.push(
				issue(
					'warning',
					'UNREFERENCED_ITEM',
					`Item ${item.id} is not referenced by any track`,
					{itemId: item.id},
				),
			);
		}

		if (!Number.isFinite(item.durationInFrames) || item.durationInFrames <= 0) {
			issues.push(
				issue(
					'error',
					'INVALID_ITEM_DURATION',
					`Item ${item.id} durationInFrames must be greater than 0`,
					{itemId: item.id},
				),
			);
		}

		const assetId = getItemAssetId(item);
		if (!assetId) {
			continue;
		}

		const asset = project.assets[assetId];
		if (!asset) {
			issues.push(
				issue(
					'error',
					'MISSING_ASSET',
					`Item ${item.id} references missing asset ${assetId}`,
					{itemId: item.id, assetId},
				),
			);
			continue;
		}

		if (asset.type !== 'caption' && !asset.remoteUrl) {
			issues.push(
				issue(
					'error',
					'MISSING_REMOTE_URL',
					`Asset ${asset.id} has no remoteUrl`,
					{itemId: item.id, assetId: asset.id},
				),
			);
		}

		if (item.type === 'captions' && asset.type !== 'caption') {
			issues.push(
				issue(
					'error',
					'INVALID_CAPTION_ASSET',
					`Caption item ${item.id} must reference a caption asset`,
					{itemId: item.id, assetId: asset.id},
				),
			);
		}

		const assetDurationInSeconds = getAssetDurationInSeconds(asset);
		const sourceStartMs = getSourceStartMs(item);
		if (
			assetDurationInSeconds !== null &&
			sourceStartMs !== null &&
			sourceStartMs / 1000 >= assetDurationInSeconds
		) {
			issues.push(
				issue(
					'error',
					'SOURCE_START_OUT_OF_RANGE',
					`Item ${item.id} starts after its source media ends`,
					{itemId: item.id, assetId: asset.id},
				),
			);
		}
	}

	if (project.shots && project.shots.length > 0) {
		validateShotTiming(project.shots, issues);
		validateShotLinks(project, issues);
	}

	validateImageMotion(project, issues);
	validateVoiceProfiles(project, issues);
	for (const matteIssue of project.advanced
		? validateTrackMattes(project.advanced)
		: []) {
		issues.push(
			issue('error', 'TRACK_MATTE', matteIssue.message, {
				itemId: matteIssue.layerId,
			}),
		);
	}
	issues.push(...validateManualLayerBounds(project));
	issues.push(...validateMotionExposureForProject(project));
	return issues;
};
