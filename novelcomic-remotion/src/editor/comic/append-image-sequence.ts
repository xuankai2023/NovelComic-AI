import {buildImageItem} from '../compose/build-image-item';
import {
	resolveAllowedHosts,
	validateRemoteUrl,
} from '../compose/validate-remote-url';
import {expandCameraPreset, type CameraPresetId} from '../motion/presets';
import type {CameraAnimation} from '../motion/types';
import type {TrackType, UndoableState} from '../state/types';
import {domainInvariant} from './errors';
import {MAX_ASSETS, MAX_ITEMS} from './limits';
import {
	BLURRED_BACKGROUND_CONTAIN,
	PANEL_BLUR_RADIUS_PX,
	PANEL_DIM_OPACITY,
	panelFitIds,
	type PanelFitPolicy,
} from './panel-fit';
import type {Shot} from './types';
import {upsertShot} from './upsert-shot';

export const PANEL_LAYER_ID = 'panel';

export type ImageSequenceFrame = {
	shotId: string;
	url: string;
	width: number;
	height: number;
	durationInFrames: number;
	cameraPresetId?: CameraPresetId;
	seed?: number;
};

export type AppendImageSequenceInput = {
	images: ImageSequenceFrame[];
	allowedHosts?: readonly string[];
	panelFitPolicy?: PanelFitPolicy;
	blurRadiusPx?: number;
	dimOpacity?: number;
	compositionWidth?: number;
	compositionHeight?: number;
};

export const panelIds = (
	shotId: string,
): {assetId: string; itemId: string; trackId: string} => {
	return {
		assetId: `asset:${shotId}:${PANEL_LAYER_ID}`,
		itemId: `item:${shotId}:${PANEL_LAYER_ID}`,
		trackId: `track:${shotId}:${PANEL_LAYER_ID}`,
	};
};

const assertCapacity = (
	project: UndoableState,
	ids: {assetId: string; itemIds: string[]},
	shotId: string,
) => {
	const assetIsNew = project.assets[ids.assetId] === undefined;
	const newItems = ids.itemIds.filter((itemId) => {
		return project.items[itemId] === undefined;
	}).length;
	if (assetIsNew && Object.keys(project.assets).length >= MAX_ASSETS) {
		throw domainInvariant(`Asset count cannot exceed ${MAX_ASSETS}`, {
			shotId,
			assetId: ids.assetId,
		});
	}

	if (Object.keys(project.items).length + newItems > MAX_ITEMS) {
		throw domainInvariant(`Item count cannot exceed ${MAX_ITEMS}`, {
			shotId,
			itemId: ids.itemIds[0],
		});
	}
};

const upsertTrack = (tracks: TrackType[], track: TrackType): TrackType[] => {
	const exists = tracks.some((entry) => {
		return entry.id === track.id;
	});
	if (!exists) {
		return [...tracks, track];
	}

	return tracks.map((entry) => {
		if (entry.id !== track.id) {
			return entry;
		}

		return {
			...entry,
			items: track.items,
			shotId: track.shotId,
			semantic: track.semantic,
			name: track.name,
			role: track.role ?? entry.role,
			hidden: false,
			muted: false,
		};
	});
};

const placePanel = (
	project: UndoableState,
	shot: Shot,
	image: ImageSequenceFrame,
): UndoableState => {
	const ids = panelIds(image.shotId);
	assertCapacity(
		project,
		{assetId: ids.assetId, itemIds: [ids.itemId]},
		image.shotId,
	);
	const placement = buildImageItem({
		id: ids.itemId,
		assetId: ids.assetId,
		trackId: ids.trackId,
		remoteUrl: image.url,
		width: image.width,
		height: image.height,
		from: shot.from,
		durationInFrames: shot.durationInFrames,
		compositionWidth: project.compositionWidth,
		compositionHeight: project.compositionHeight,
		shotId: shot.id,
		layerId: PANEL_LAYER_ID,
		trackName: shot.name,
		semantic: 'background',
	});
	const trackExists = project.tracks.some((track) => {
		return track.id === ids.trackId;
	});
	const tracks = trackExists
		? project.tracks.map((track) => {
				if (track.id !== ids.trackId) {
					return track;
				}

				return {
					...track,
					items: [placement.item.id],
					shotId: shot.id,
					semantic: placement.track.semantic,
					name: placement.track.name,
					role: 'source' as const,
					hidden: false,
					muted: false,
				};
			})
		: [...project.tracks, {...placement.track, role: 'source' as const}];
	const layerTrackIds = shot.layerTrackIds.includes(ids.trackId)
		? shot.layerTrackIds
		: [...shot.layerTrackIds, ids.trackId];

	return {
		...project,
		tracks,
		items: {
			...project.items,
			[placement.item.id]: placement.item,
		},
		assets: {
			...project.assets,
			[placement.asset.id]: placement.asset,
		},
		shots: (project.shots ?? []).map((entry) => {
			if (entry.id !== shot.id) {
				return entry;
			}

			return {
				...entry,
				layerTrackIds,
			};
		}),
	};
};

const placeBlurredPanel = (
	project: UndoableState,
	shot: Shot,
	image: ImageSequenceFrame,
	blurRadiusPx: number,
	dimOpacity: number,
): UndoableState => {
	const ids = panelFitIds(image.shotId);
	const legacy = panelIds(image.shotId);
	assertCapacity(
		project,
		{
			assetId: ids.assetId,
			itemIds: [ids.foregroundItemId, ids.backgroundItemId],
		},
		image.shotId,
	);
	const shared = {
		remoteUrl: image.url,
		width: image.width,
		height: image.height,
		from: shot.from,
		durationInFrames: shot.durationInFrames,
		compositionWidth: project.compositionWidth,
		compositionHeight: project.compositionHeight,
		shotId: shot.id,
	};
	const foreground = buildImageItem({
		...shared,
		id: ids.foregroundItemId,
		assetId: ids.assetId,
		trackId: ids.foregroundTrackId,
		layerId: 'panel-foreground',
		trackName: shot.name,
		semantic: 'foreground',
		fit: 'contain',
		role: 'panel-foreground',
	});
	const background = buildImageItem({
		...shared,
		id: ids.backgroundItemId,
		assetId: ids.assetId,
		trackId: ids.backgroundTrackId,
		layerId: 'panel-background',
		trackName: shot.name,
		semantic: 'background',
		fit: 'cover',
		role: 'panel-background',
		blurRadiusPx,
		dimOpacity,
	});
	const items = {...project.items};
	delete items[legacy.itemId];
	let tracks = project.tracks.filter((track) => {
		return track.id !== legacy.trackId;
	});
	tracks = upsertTrack(tracks, {
		...foreground.track,
		role: 'source',
	});
	tracks = upsertTrack(tracks, {
		...background.track,
		role: 'source',
	});
	const withoutPlate = shot.layerTrackIds.filter((trackId) => {
		return (
			trackId !== legacy.trackId &&
			trackId !== ids.foregroundTrackId &&
			trackId !== ids.backgroundTrackId
		);
	});
	const layerTrackIds = [
		...withoutPlate,
		ids.foregroundTrackId,
		ids.backgroundTrackId,
	];

	return {
		...project,
		tracks,
		items: {
			...items,
			[foreground.item.id]: foreground.item,
			[background.item.id]: background.item,
		},
		assets: {
			...project.assets,
			[foreground.asset.id]: foreground.asset,
		},
		shots: (project.shots ?? []).map((entry) => {
			if (entry.id !== shot.id) {
				return entry;
			}

			return {
				...entry,
				layerTrackIds,
			};
		}),
	};
};

export const appendImageSequence = (
	project: UndoableState,
	input: AppendImageSequenceInput,
): UndoableState => {
	if (input.images.length === 0) {
		throw domainInvariant('At least one image is required');
	}

	const blurred = input.panelFitPolicy === BLURRED_BACKGROUND_CONTAIN;
	const blurRadiusPx = input.blurRadiusPx ?? PANEL_BLUR_RADIUS_PX;
	const dimOpacity = input.dimOpacity ?? PANEL_DIM_OPACITY;
	if (
		blurred &&
		(blurRadiusPx !== PANEL_BLUR_RADIUS_PX || dimOpacity !== PANEL_DIM_OPACITY)
	) {
		throw domainInvariant(
			'blurred-background-contain requires blur radius 28 and dim opacity 0.45',
		);
	}

	const allowedHosts = resolveAllowedHosts(input.allowedHosts);
	for (const image of input.images) {
		validateRemoteUrl(image.url, {allowedHosts});
		if (
			!Number.isInteger(image.width) ||
			image.width < 1 ||
			!Number.isInteger(image.height) ||
			image.height < 1
		) {
			throw domainInvariant('Image dimensions must be positive', {
				shotId: image.shotId,
			});
		}
	}

	const sized =
		input.compositionWidth !== undefined &&
		input.compositionHeight !== undefined
			? {
					...project,
					compositionWidth: input.compositionWidth,
					compositionHeight: input.compositionHeight,
				}
			: project;

	return input.images.reduce((current, image) => {
		let cameraMotion: CameraAnimation | undefined;
		if (image.cameraPresetId) {
			try {
				cameraMotion = {
					...expandCameraPreset(image.cameraPresetId, {
						durationInFrames: image.durationInFrames,
						seed: image.seed,
					}),
					focalX: current.compositionWidth / 2,
					focalY: current.compositionHeight / 2,
				};
			} catch (error) {
				throw domainInvariant(
					error instanceof Error ? error.message : 'Unknown camera preset',
					{shotId: image.shotId},
				);
			}
		}

		const withShot = upsertShot(current, {
			shotId: image.shotId,
			durationInFrames: image.durationInFrames,
			cameraMotion,
		});
		const shot = withShot.shots?.find((entry) => {
			return entry.id === image.shotId;
		});
		if (!shot) {
			throw domainInvariant(`Shot ${image.shotId} was not created`, {
				shotId: image.shotId,
			});
		}

		if (blurred) {
			return placeBlurredPanel(withShot, shot, image, blurRadiusPx, dimOpacity);
		}

		return placePanel(withShot, shot, image);
	}, sized);
};
