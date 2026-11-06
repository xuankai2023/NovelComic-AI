import type {ImageAsset} from '../assets/assets';
import type {ImageItem} from '../items/image/image-item-type';
import type {UndoableState} from '../state/types';
import {applyMotion} from './apply-motion';
import {applySpriteMotion} from './apply-sprite-motion';
import {domainInvariant} from './errors';
import {importLayers, spriteAssetId} from './import-layers';
import type {
	ComicLayer,
	ComicLayerSemantic,
	LayerAnchor,
	LayerBounds,
	LayerPackage,
} from './types';

type ManualLayerRecord = NonNullable<UndoableState['comicEditLayers']>[string];

export type ManualLayerPackageOptions = {
	allowedHosts?: readonly string[];
	applyDefaultMotion?: boolean;
	animationSeed?: number;
};

const imageAsset = (
	project: UndoableState,
	assetId: string,
	label: string,
): ImageAsset => {
	const asset = project.assets[assetId];
	if (!asset || asset.type !== 'image') {
		throw domainInvariant(`${label} ${assetId} is not an image asset`, {
			assetId,
		});
	}

	return asset;
};

const remoteUrlFor = (
	project: UndoableState,
	assetId: string,
	label: string,
): string => {
	const asset = imageAsset(project, assetId, label);
	if (!asset.remoteUrl) {
		throw domainInvariant(`${label} ${assetId} has not finished uploading`, {
			assetId,
		});
	}

	return asset.remoteUrl;
};

const logicalLayerId = (
	semantic: ComicLayerSemantic,
	layerId: string,
): string => {
	if (semantic.startsWith('eye-')) {
		return 'eye';
	}

	if (semantic.startsWith('mouth-')) {
		return 'mouth';
	}

	return layerId;
};

const defaultAnchorFor = (semantic: ComicLayerSemantic): LayerAnchor => {
	if (semantic === 'hair') {
		return {x: 0.5, y: 0};
	}

	return {x: 0.5, y: 0.5};
};

const cloneBounds = (bounds: LayerBounds): LayerBounds => {
	return {...bounds};
};

const layerShotId = (
	project: UndoableState,
	layer: ManualLayerRecord,
): string | undefined => {
	if (layer.shotId) {
		return layer.shotId;
	}

	if (!layer.sourceItemId) {
		return undefined;
	}

	const sourceItem = project.items[layer.sourceItemId];
	return sourceItem?.type === 'image' ? sourceItem.shotId : undefined;
};

const findSourceCanvas = (
	layers: readonly ManualLayerRecord[],
): {width: number; height: number} => {
	const first = layers[0];
	if (!first) {
		throw new Error('Manual layer list is empty');
	}

	for (const layer of layers) {
		if (
			layer.sourceCanvas.width !== first.sourceCanvas.width ||
			layer.sourceCanvas.height !== first.sourceCanvas.height
		) {
			throw domainInvariant(
				'Manual layers in one shot must share a source canvas',
				{
					shotId: layer.shotId,
				},
			);
		}
	}

	return {...first.sourceCanvas};
};

const assertVariantGeometry = (layers: readonly ManualLayerRecord[]): void => {
	const variants = new Map<
		string,
		{bounds: LayerBounds; anchor: LayerAnchor}
	>();

	for (const layer of layers) {
		const groupId = logicalLayerId(layer.semantic, layer.id);
		const anchor = layer.anchor ?? defaultAnchorFor(layer.semantic);
		const previous = variants.get(groupId);
		if (!previous) {
			variants.set(groupId, {bounds: cloneBounds(layer.bounds), anchor});
			continue;
		}

		if (
			previous.bounds.x !== layer.bounds.x ||
			previous.bounds.y !== layer.bounds.y ||
			previous.bounds.width !== layer.bounds.width ||
			previous.bounds.height !== layer.bounds.height ||
			previous.anchor.x !== anchor.x ||
			previous.anchor.y !== anchor.y
		) {
			throw domainInvariant(
				`Manual sprite variants in ${groupId} must share bounds and anchor`,
				{itemId: groupId, shotId: layer.shotId},
			);
		}
	}
};

const cleanPlateLayer = (
	project: UndoableState,
	layers: readonly ManualLayerRecord[],
	sourceCanvas: {width: number; height: number},
): ComicLayer | null => {
	const cleanPlateAssetId = layers.find(
		(layer) => layer.cleanPlateAssetId,
	)?.cleanPlateAssetId;
	if (!cleanPlateAssetId) {
		return null;
	}

	for (const layer of layers) {
		if (
			layer.cleanPlateAssetId &&
			layer.cleanPlateAssetId !== cleanPlateAssetId
		) {
			throw domainInvariant(
				'Manual layers in one shot must share a clean plate',
				{
					shotId: layer.shotId,
				},
			);
		}
	}

	const asset = imageAsset(project, cleanPlateAssetId, 'Clean plate asset');
	if (
		asset.width !== sourceCanvas.width ||
		asset.height !== sourceCanvas.height
	) {
		throw domainInvariant(
			'Clean plate dimensions must match the source canvas',
			{
				assetId: cleanPlateAssetId,
			},
		);
	}

	const minimumZIndex = Math.min(...layers.map((layer) => layer.zIndex));
	return {
		layerId: 'clean-plate',
		name: 'Clean plate',
		semantic: 'background',
		imageUrl: remoteUrlFor(project, cleanPlateAssetId, 'Clean plate asset'),
		isCleanPlate: true,
		opacity: 1,
		zIndex: minimumZIndex - 1,
		visible: true,
		bounds: {
			x: 0,
			y: 0,
			width: sourceCanvas.width,
			height: sourceCanvas.height,
		},
		anchor: {x: 0.5, y: 0.5},
		confidence: 1,
		motionPolicy: 'static',
	};
};

const toComicLayer = (
	project: UndoableState,
	layer: ManualLayerRecord,
): ComicLayer => {
	if (!layer.cutoutAssetId) {
		throw domainInvariant(`Manual layer ${layer.id} has no cutout asset`, {
			itemId: layer.id,
			shotId: layer.shotId,
		});
	}

	const cutout = imageAsset(project, layer.cutoutAssetId, 'Cutout asset');
	if (
		cutout.width !== Math.round(layer.bounds.width) ||
		cutout.height !== Math.round(layer.bounds.height)
	) {
		throw domainInvariant(
			`Manual layer ${layer.id} cutout dimensions do not match its bounds`,
			{itemId: layer.id, assetId: layer.cutoutAssetId},
		);
	}

	return {
		layerId: layer.id,
		name: layer.name,
		semantic: layer.semantic,
		imageUrl: remoteUrlFor(project, layer.cutoutAssetId, 'Cutout asset'),
		...(layer.maskAssetId
			? {
					maskUrl: remoteUrlFor(project, layer.maskAssetId, 'Mask asset'),
				}
			: {}),
		isCleanPlate: false,
		opacity: layer.opacity,
		zIndex: layer.zIndex,
		visible: layer.visible,
		bounds: cloneBounds(layer.bounds),
		anchor: layer.anchor ?? defaultAnchorFor(layer.semantic),
		confidence: 1,
		motionPolicy: layer.semantic === 'hair' ? 'subtle' : 'static',
	};
};

const layersForShot = (
	project: UndoableState,
	shotId: string,
): ManualLayerRecord[] => {
	const layers = Object.values(project.comicEditLayers ?? {}).filter(
		(layer) => {
			return layerShotId(project, layer) === shotId;
		},
	);
	if (layers.length === 0) {
		throw domainInvariant(`Shot ${shotId} has no manual comic layers`, {
			shotId,
		});
	}

	return layers.sort((left, right) => {
		if (left.zIndex !== right.zIndex) {
			return left.zIndex - right.zIndex;
		}

		return left.id.localeCompare(right.id);
	});
};

export const buildManualLayerPackage = (
	project: UndoableState,
	shotId: string,
): LayerPackage => {
	const shot = (project.shots ?? []).find((entry) => entry.id === shotId);
	if (!shot) {
		throw domainInvariant(`Shot ${shotId} does not exist`, {shotId});
	}

	const layers = layersForShot(project, shotId);
	const sourceCanvas = findSourceCanvas(layers);
	assertVariantGeometry(layers);

	const sourceAssetId = layers[0]?.sourceAssetId;
	if (!sourceAssetId) {
		throw domainInvariant(`Shot ${shotId} has no source asset`, {shotId});
	}

	const sourceAsset = imageAsset(project, sourceAssetId, 'Source asset');
	if (
		sourceAsset.width !== sourceCanvas.width ||
		sourceAsset.height !== sourceCanvas.height
	) {
		throw domainInvariant(
			'Source asset dimensions must match the source canvas',
			{
				assetId: sourceAssetId,
			},
		);
	}

	for (const layer of layers) {
		if (layer.sourceAssetId !== sourceAssetId) {
			throw domainInvariant(
				'Manual layers in one shot must share a source asset',
				{
					shotId,
				},
			);
		}
	}

	const manualLayers = layers.map((layer) => toComicLayer(project, layer));
	const cleanPlate = cleanPlateLayer(project, layers, sourceCanvas);
	const packageLayers = cleanPlate
		? [cleanPlate, ...manualLayers]
		: manualLayers;

	return {
		schemaVersion: 1,
		projectId: `manual:${shotId}`,
		shotId,
		sourceUrl: remoteUrlFor(project, sourceAssetId, 'Source asset'),
		canvas: sourceCanvas,
		layers: packageLayers,
		diagnostics: {
			recompositionScore: 0,
			alphaHoleRatio: 0,
			edgeArtifactScore: 0,
			requiresFallback: false,
			warnings: cleanPlate
				? ['manual-layer-package']
				: ['manual-layer-package', 'manual-cutouts-without-clean-plate'],
		},
	};
};

const removeLegacyManualItems = (
	project: UndoableState,
	layers: readonly ManualLayerRecord[],
): UndoableState => {
	const legacyLayerIds = new Set(layers.map((layer) => layer.id));
	const legacyItemIds = new Set(
		Object.values(project.items)
			.filter(
				(item): item is ImageItem =>
					item.type === 'image' &&
					item.layerId !== undefined &&
					legacyLayerIds.has(item.layerId),
			)
			.map((item) => item.id),
	);
	if (legacyItemIds.size === 0) {
		return project;
	}

	const removedTrackIds = new Set<string>();
	const tracks = project.tracks.flatMap((track) => {
		const remainingItems = track.items.filter((itemId) => {
			return !legacyItemIds.has(itemId);
		});
		if (remainingItems.length === 0 && track.items.length > 0) {
			removedTrackIds.add(track.id);
			return [];
		}

		return [{...track, items: remainingItems}];
	});
	const items = {...project.items};
	for (const itemId of legacyItemIds) {
		delete items[itemId];
	}

	return {
		...project,
		tracks,
		items,
		shots: (project.shots ?? []).map((shot) => ({
			...shot,
			layerTrackIds: shot.layerTrackIds.filter(
				(trackId) => !removedTrackIds.has(trackId),
			),
		})),
	};
};

const importedItemId = (shotId: string, groupId: string): string => {
	return `item:${shotId}:${groupId}`;
};

const applyDefaultManualMotion = (
	project: UndoableState,
	shotId: string,
	seed: number,
): UndoableState => {
	const shot = (project.shots ?? []).find((entry) => entry.id === shotId);
	if (!shot) {
		throw domainInvariant(`Shot ${shotId} does not exist`, {shotId});
	}

	let next = project;
	const layers = Object.values(project.comicEditLayers ?? {}).filter(
		(layer) => {
			return layerShotId(project, layer) === shotId;
		},
	);
	const byGroup = new Map<string, ManualLayerRecord[]>();
	for (const layer of layers) {
		const groupId = logicalLayerId(layer.semantic, layer.id);
		const current = byGroup.get(groupId) ?? [];
		current.push(layer);
		byGroup.set(groupId, current);
	}

	const hairLayer = byGroup.get('hair')?.[0];
	if (hairLayer) {
		const itemId = importedItemId(shotId, 'hair');
		if (next.items[itemId]?.type === 'image') {
			next = applyMotion(next, {
				target: {type: 'item', itemId, presetId: 'hair-sway'},
				mode: 'replace',
				seed,
			});
		}
	}

	const eyeLayers = byGroup.get('eye') ?? [];
	if (
		eyeLayers.some((layer) => layer.semantic === 'eye-open') &&
		eyeLayers.some((layer) => layer.semantic === 'eye-closed')
	) {
		const itemId = importedItemId(shotId, 'eye');
		const item = next.items[itemId];
		if (item?.type === 'image') {
			next = applySpriteMotion(next, {
				itemId,
				mode: 'replace',
				sprite: {
					kind: 'blink',
					openAssetId: spriteAssetId(shotId, 'eye', 'eye-open'),
					closedAssetId: spriteAssetId(shotId, 'eye', 'eye-closed'),
					seed,
				},
			});
		}
	}

	const mouthLayers = byGroup.get('mouth') ?? [];
	const hasClosed = mouthLayers.some(
		(layer) => layer.semantic === 'mouth-closed',
	);
	const hasOpen = mouthLayers.some((layer) => layer.semantic === 'mouth-open');
	if (hasClosed && hasOpen && shot.dialogueItemIds.length > 0) {
		const itemId = importedItemId(shotId, 'mouth');
		const item = next.items[itemId];
		if (item?.type === 'image') {
			const hasHalf = mouthLayers.some(
				(layer) => layer.semantic === 'mouth-half',
			);
			next = applySpriteMotion(next, {
				itemId,
				mode: 'replace',
				sprite: {
					kind: 'mouth-flap',
					closedAssetId: spriteAssetId(shotId, 'mouth', 'mouth-closed'),
					halfAssetId: hasHalf
						? spriteAssetId(shotId, 'mouth', 'mouth-half')
						: undefined,
					openAssetId: spriteAssetId(shotId, 'mouth', 'mouth-open'),
					dialogueItemIds: shot.dialogueItemIds,
				},
			});
		}
	}

	return next;
};

/**
 * Rebuilds manually extracted layers through the same stable LayerPackage
 * importer used by automated segmentation and optionally applies the
 * dynamic-comic motion defaults.
 */
export const importManualLayers = (
	project: UndoableState,
	shotId: string,
	options?: ManualLayerPackageOptions,
): UndoableState => {
	const layerPackage = buildManualLayerPackage(project, shotId);
	const layers = layersForShot(project, shotId);
	const withoutLegacyItems = removeLegacyManualItems(project, layers);
	let next = importLayers(withoutLegacyItems, layerPackage, options);

	if (options?.applyDefaultMotion ?? true) {
		next = applyDefaultManualMotion(next, shotId, options?.animationSeed ?? 1);
	}

	return next;
};
