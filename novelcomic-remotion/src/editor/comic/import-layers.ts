import type {ImageAsset} from '../assets/assets';
import {
	resolveAllowedHosts,
	validateRemoteUrl,
} from '../compose/validate-remote-url';
import type {ImageItem} from '../items/image/image-item-type';
import type {ImageMotion} from '../motion/types';
import type {TrackType, UndoableState} from '../state/types';
import {panelIds} from './append-image-sequence';
import {COMIC_ERROR_CODES, ComicEditorError, domainInvariant} from './errors';
import {MAX_ASSETS, MAX_ITEMS} from './limits';
import {panelFitIds} from './panel-fit';
import {reorderComicTracks} from './reorder-comic-tracks';
import {sourceBoundsToComposition} from './source-to-composition';
import type {ComicLayer, ComicLayerSemantic, LayerPackage, Shot} from './types';
import {cloneUndoableState} from './upsert-shot';
import {validateProject} from './validate-project';

export type ImportLayersOptions = {
	allowedHosts?: readonly string[];
};

const EYE_ORDER = ['eye-open', 'eye-closed'] as const;
const MOUTH_ORDER = ['mouth-closed', 'mouth-half', 'mouth-open'] as const;

type LayerGroup = {
	id: string;
	layers: ComicLayer[];
	zIndex: number;
};

const isExplicitCleanPlateLayer = (layer: ComicLayer): boolean => {
	return layer.isCleanPlate === true || layer.layerId === 'clean-plate';
};

const isLegacyCleanPlateLayer = (layer: ComicLayer): boolean => {
	return (
		layer.isCleanPlate !== false &&
		(layer.semantic === 'background' || layer.semantic === 'foreground')
	);
};

const logicalLayerId = (layer: ComicLayer): string => {
	if (isExplicitCleanPlateLayer(layer)) {
		return 'clean-plate';
	}

	if (layer.semantic.startsWith('eye-')) {
		return 'eye';
	}

	if (layer.semantic.startsWith('mouth-')) {
		return 'mouth';
	}

	return layer.layerId;
};

// Player, preview, and Lambda share these ids with the agent:
// asset:{shotId}:eye:open, not asset:{shotId}:eye:eye-open.
const spriteToken = (groupId: string, semantic: string): string => {
	const prefix = `${groupId}-`;
	return semantic.startsWith(prefix) ? semantic.slice(prefix.length) : semantic;
};

export const spriteAssetId = (
	shotId: string,
	groupId: string,
	semantic: string,
): string => {
	return `asset:${shotId}:${groupId}:${spriteToken(groupId, semantic)}`;
};

const stateOrder = (semantic: ComicLayerSemantic): number => {
	const eye = EYE_ORDER.indexOf(semantic as (typeof EYE_ORDER)[number]);
	if (eye >= 0) {
		return eye;
	}

	const mouth = MOUTH_ORDER.indexOf(semantic as (typeof MOUTH_ORDER)[number]);
	if (mouth >= 0) {
		return mouth;
	}

	return 0;
};

const l0PlateTrackIds = (shotId: string): Set<string> => {
	const plate = panelIds(shotId);
	const fit = panelFitIds(shotId);
	return new Set([plate.trackId, fit.foregroundTrackId, fit.backgroundTrackId]);
};

const hideL0PanelTrack = (
	project: UndoableState,
	shotId: string,
): UndoableState => {
	const plateIds = l0PlateTrackIds(shotId);
	return {
		...project,
		tracks: project.tracks.map((track) => {
			if (!plateIds.has(track.id) || track.hidden) {
				return track;
			}

			return {...track, hidden: true};
		}),
	};
};

const hasCleanPlateLayer = (layerPackage: LayerPackage): boolean => {
	return layerPackage.layers.some((layer) => {
		return (
			layer.visible &&
			(layer.opacity ?? 1) > 0 &&
			(isExplicitCleanPlateLayer(layer) || isLegacyCleanPlateLayer(layer))
		);
	});
};

const isEnhancementTrack = (track: TrackType, shotId: string): boolean => {
	return (
		track.shotId === shotId &&
		!l0PlateTrackIds(shotId).has(track.id) &&
		track.semantic !== 'dialogue'
	);
};

export const restoreL0 = (
	project: UndoableState,
	shotId: string,
): UndoableState => {
	const ids = panelIds(shotId);
	const shot = (project.shots ?? []).find((entry) => {
		return entry.id === shotId;
	});
	if (!shot) {
		throw domainInvariant(`Shot ${shotId} does not exist`, {shotId});
	}

	const fit = panelFitIds(shotId);
	const plateIds = l0PlateTrackIds(shotId);
	const plateItemId = project.items[ids.itemId]
		? ids.itemId
		: fit.foregroundItemId;
	if (!project.assets[ids.assetId] || !project.items[plateItemId]) {
		throw domainInvariant('L0 panel asset is missing', {
			shotId,
			assetId: ids.assetId,
			itemId: plateItemId,
		});
	}

	if (!project.tracks.some((track) => plateIds.has(track.id))) {
		throw domainInvariant('L0 panel track is missing', {
			shotId,
			itemId: plateItemId,
		});
	}

	const next: UndoableState = {
		...cloneUndoableState(project),
		tracks: project.tracks.map((track) => {
			if (plateIds.has(track.id)) {
				return {...track, hidden: false};
			}

			if (isEnhancementTrack(track, shotId)) {
				return {...track, hidden: true};
			}

			return track;
		}),
	};
	const reordered = reorderComicTracks(next);
	const error = validateProject(reordered).find((entry) => {
		return entry.severity === 'error';
	});
	if (error) {
		throw domainInvariant(`${error.code}: ${error.message}`, {
			shotId: error.shotId,
			itemId: error.itemId,
			assetId: error.assetId,
		});
	}

	return reordered;
};

const filenameFromUrl = (remoteUrl: string, fallback: string): string => {
	try {
		const name = new URL(remoteUrl).pathname.split('/').filter(Boolean).pop();
		if (name) {
			return name;
		}
	} catch {
		return fallback;
	}

	return fallback;
};

const mimeFromFilename = (filename: string): string => {
	const lower = filename.toLowerCase();
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
		return 'image/jpeg';
	}

	if (lower.endsWith('.webp')) {
		return 'image/webp';
	}

	if (lower.endsWith('.gif')) {
		return 'image/gif';
	}

	return 'image/png';
};

const groupLayers = (layers: readonly ComicLayer[]): LayerGroup[] => {
	const groups = new Map<string, ComicLayer[]>();
	for (const layer of layers) {
		const id = logicalLayerId(layer);
		const current = groups.get(id) ?? [];
		if (current.some((entry) => entry.semantic === layer.semantic)) {
			throw domainInvariant(`Layer semantic ${layer.semantic} is duplicated`, {
				itemId: id,
			});
		}

		if (
			current.length > 0 &&
			id !== 'eye' &&
			id !== 'mouth' &&
			current.some((entry) => entry.layerId === layer.layerId)
		) {
			throw domainInvariant(`Layer ${layer.layerId} is duplicated`, {
				itemId: layer.layerId,
			});
		}

		current.push(layer);
		groups.set(id, current);
	}

	return [...groups.entries()]
		.map(([id, members]) => {
			const ordered = [...members].sort((left, right) => {
				return stateOrder(left.semantic) - stateOrder(right.semantic);
			});
			return {
				id,
				layers: ordered,
				zIndex: ordered[0]?.zIndex ?? 0,
			};
		})
		.sort((left, right) => {
			if (left.zIndex !== right.zIndex) {
				return right.zIndex - left.zIndex;
			}

			return left.id.localeCompare(right.id);
		});
};

const scaledBounds = (
	layer: ComicLayer,
	layerPackage: LayerPackage,
	project: UndoableState,
): {left: number; top: number; width: number; height: number} => {
	const bounds = sourceBoundsToComposition(layer.bounds, layerPackage.canvas, {
		width: project.compositionWidth,
		height: project.compositionHeight,
	});
	const width = Math.round(bounds.width);
	const height = Math.round(bounds.height);
	if (width < 1 || height < 1) {
		throw domainInvariant(`Layer ${layer.layerId} is outside the canvas`, {
			itemId: layer.layerId,
		});
	}

	return {
		left: Math.round(bounds.x),
		top: Math.round(bounds.y),
		width,
		height,
	};
};

const placeGroup = (
	project: UndoableState,
	shot: Shot,
	layerPackage: LayerPackage,
	group: LayerGroup,
): UndoableState => {
	const primary = group.layers[0];
	if (!primary) {
		throw domainInvariant('Layer group is empty', {shotId: shot.id});
	}

	if (
		!Number.isFinite(primary.anchor.x) ||
		!Number.isFinite(primary.anchor.y) ||
		primary.anchor.x < 0 ||
		primary.anchor.x > 1 ||
		primary.anchor.y < 0 ||
		primary.anchor.y > 1
	) {
		throw domainInvariant(
			`Layer ${primary.layerId} anchor must be between 0 and 1`,
			{
				shotId: shot.id,
				itemId: group.id,
			},
		);
	}

	const itemId = `item:${shot.id}:${group.id}`;
	const trackId = `track:${shot.id}:${group.id}`;
	const geometry = scaledBounds(primary, layerPackage, project);
	const useSprites = group.layers.length > 1;
	const spriteAssetIds = useSprites
		? group.layers.map((layer) => {
				return spriteAssetId(shot.id, group.id, layer.semantic);
			})
		: undefined;
	const primaryAssetId = useSprites
		? (spriteAssetIds?.[0] ?? `asset:${shot.id}:${group.id}`)
		: `asset:${shot.id}:${group.id}`;
	const assets = {...project.assets};
	for (const layer of group.layers) {
		const assetId = useSprites
			? spriteAssetId(shot.id, group.id, layer.semantic)
			: primaryAssetId;
		if (
			assets[assetId] === undefined &&
			Object.keys(assets).length >= MAX_ASSETS
		) {
			throw domainInvariant(`Asset count cannot exceed ${MAX_ASSETS}`, {
				shotId: shot.id,
				assetId,
			});
		}

		const filename = filenameFromUrl(layer.imageUrl, `${assetId}.png`);
		const asset: ImageAsset = {
			id: assetId,
			type: 'image',
			filename,
			size: 0,
			remoteUrl: layer.imageUrl,
			remoteFileKey: null,
			mimeType: mimeFromFilename(filename),
			width: Math.max(1, Math.round(layer.bounds.width)),
			height: Math.max(1, Math.round(layer.bounds.height)),
		};
		assets[assetId] = asset;
	}

	const itemIsNew = project.items[itemId] === undefined;
	if (itemIsNew && Object.keys(project.items).length >= MAX_ITEMS) {
		throw domainInvariant(`Item count cannot exceed ${MAX_ITEMS}`, {
			shotId: shot.id,
			itemId,
		});
	}

	const previous = project.items[itemId];
	const previousMotion =
		previous?.type === 'image' ? previous.motion : undefined;
	const anchorIsCustom = primary.anchor.x !== 0.5 || primary.anchor.y !== 0.5;
	let motion: ImageMotion | undefined = previousMotion;
	if (anchorIsCustom || previousMotion) {
		motion = {
			...previousMotion,
		};
		if (previousMotion?.transform || anchorIsCustom) {
			motion = {
				...motion,
				transform: {
					keyframes: previousMotion?.transform?.keyframes ?? [],
					...previousMotion?.transform,
					anchorX: primary.anchor.x,
					anchorY: primary.anchor.y,
				},
			};
		}
	}

	const item: ImageItem = {
		id: itemId,
		type: 'image',
		assetId: primaryAssetId,
		durationInFrames: shot.durationInFrames,
		from: shot.from,
		top: geometry.top,
		left: geometry.left,
		width: geometry.width,
		height: geometry.height,
		opacity: primary.opacity ?? 1,
		isDraggingInTimeline: false,
		borderRadius: 0,
		rotation: 0,
		keepAspectRatio: true,
		fadeInDurationInSeconds: 0,
		fadeOutDurationInSeconds: 0,
		cropLeft: 0,
		cropTop: 0,
		cropRight: 0,
		cropBottom: 0,
		shotId: shot.id,
		layerId: group.id,
		spriteAssetIds:
			spriteAssetIds ??
			(previous?.type === 'image' ? previous.spriteAssetIds : undefined),
		motion,
	};
	const track: TrackType = {
		id: trackId,
		items: [item.id],
		hidden: !primary.visible,
		muted: false,
		name: primary.name,
		shotId: shot.id,
		semantic: primary.semantic,
		role: isExplicitCleanPlateLayer(primary) ? 'clean-plate' : 'cutout',
	};
	const tracks = project.tracks.some((entry) => entry.id === trackId)
		? project.tracks.map((entry) => {
				return entry.id === trackId ? track : entry;
			})
		: [...project.tracks, track];

	return {
		...project,
		tracks,
		assets,
		items: {
			...project.items,
			[item.id]: item,
		},
	};
};

export const importLayers = (
	project: UndoableState,
	layerPackage: LayerPackage,
	options?: ImportLayersOptions,
): UndoableState => {
	if (layerPackage.schemaVersion !== 1) {
		throw domainInvariant('Layer package schema is not supported', {
			shotId: layerPackage.shotId,
		});
	}

	if (layerPackage.diagnostics.requiresFallback) {
		throw new ComicEditorError({
			code: COMIC_ERROR_CODES.LAYER_PACKAGE_FALLBACK_REQUIRED,
			message: 'Layer package requires fallback',
			retryable: false,
			status: 422,
			shotId: layerPackage.shotId,
		});
	}

	if (layerPackage.layers.length === 0) {
		throw domainInvariant('Layer package has no layers', {
			shotId: layerPackage.shotId,
		});
	}

	if (
		!Number.isFinite(layerPackage.canvas.width) ||
		layerPackage.canvas.width < 1 ||
		!Number.isFinite(layerPackage.canvas.height) ||
		layerPackage.canvas.height < 1
	) {
		throw domainInvariant('Layer package canvas must be positive', {
			shotId: layerPackage.shotId,
		});
	}

	const allowedHosts = resolveAllowedHosts(options?.allowedHosts);
	validateRemoteUrl(layerPackage.sourceUrl, {allowedHosts});
	for (const layer of layerPackage.layers) {
		validateRemoteUrl(layer.imageUrl, {allowedHosts});
		if (
			!Number.isFinite(layer.bounds.width) ||
			layer.bounds.width <= 0 ||
			!Number.isFinite(layer.bounds.height) ||
			layer.bounds.height <= 0
		) {
			throw domainInvariant(`Layer ${layer.layerId} bounds must be positive`, {
				shotId: layerPackage.shotId,
				itemId: layer.layerId,
			});
		}
	}

	const groups = groupLayers(layerPackage.layers);
	let next = cloneUndoableState(project);
	const shot = (next.shots ?? []).find((entry) => {
		return entry.id === layerPackage.shotId;
	});
	if (!shot) {
		throw domainInvariant(`Shot ${layerPackage.shotId} does not exist`, {
			shotId: layerPackage.shotId,
		});
	}

	for (const group of groups) {
		const currentShot = (next.shots ?? []).find((entry) => {
			return entry.id === shot.id;
		});
		if (!currentShot) {
			throw domainInvariant(`Shot ${shot.id} does not exist`, {
				shotId: shot.id,
			});
		}

		next = placeGroup(next, currentShot, layerPackage, group);
	}

	const importedTrackIds = groups.map((group) => {
		return `track:${shot.id}:${group.id}`;
	});
	const diagnostics = [
		`recompositionScore:${layerPackage.diagnostics.recompositionScore}`,
		`alphaHoleRatio:${layerPackage.diagnostics.alphaHoleRatio}`,
		`edgeArtifactScore:${layerPackage.diagnostics.edgeArtifactScore}`,
		...layerPackage.diagnostics.warnings,
	];
	next = {
		...next,
		shots: (next.shots ?? []).map((entry) => {
			if (entry.id !== shot.id) {
				return entry;
			}

			const rest = entry.layerTrackIds.filter((trackId) => {
				return !importedTrackIds.includes(trackId);
			});
			return {
				...entry,
				layerTrackIds: [...importedTrackIds, ...rest],
				diagnostics,
			};
		}),
	};
	const withPanelVisibility = hasCleanPlateLayer(layerPackage)
		? hideL0PanelTrack(next, shot.id)
		: next;
	const reordered = reorderComicTracks(withPanelVisibility);
	const error = validateProject(reordered).find((entry) => {
		return entry.severity === 'error';
	});
	if (error) {
		throw domainInvariant(`${error.code}: ${error.message}`, {
			shotId: error.shotId,
			itemId: error.itemId,
			assetId: error.assetId,
		});
	}

	return reordered;
};
