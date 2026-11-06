import type {EditorStarterAsset} from '../assets/assets';
import {COMIC_ERROR_CODES, ComicEditorError} from '../comic/errors';
import {COMIC_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION} from '../comic/limits';
import {
	normalizeComicEditLayers,
	type ComicEditLayers,
} from '../comic/manual-layer-types';
import type {AdvancedProjectState} from '../composition/types';
import type {EditorStarterItem} from '../items/item-type';
import {normalizeEditorStarterItemsRecord} from '../items/normalize-item';
import {migrateMotionToPropertyGraph} from '../property/migrate-motion';
import type {TrackType, UndoableState} from './types';

const imageAsset = (
	assets: Record<string, EditorStarterAsset>,
	assetId: string | undefined,
) => {
	if (!assetId) {
		return undefined;
	}

	const asset = assets[assetId];
	if (asset && asset.type !== 'image') {
		throw new Error(`Comic edit layer asset ${assetId} must be an image`);
	}
	return asset?.type === 'image' ? asset : undefined;
};

const item = (
	items: Record<string, EditorStarterItem>,
	itemId: string | undefined,
) => {
	if (!itemId) {
		return undefined;
	}

	return items[itemId];
};

const assertTrackReference = ({
	tracks,
	trackId,
	itemId,
	role,
	layerId,
	label,
}: {
	tracks: readonly TrackType[];
	trackId: string | undefined;
	itemId: string | undefined;
	role: NonNullable<TrackType['role']>;
	layerId: string;
	label: string;
}) => {
	if (!trackId) {
		return;
	}

	const track = tracks.find((candidate) => candidate.id === trackId);
	if (!track) {
		throw new Error(
			`Comic edit layer ${layerId} references missing ${label} track ${trackId}`,
		);
	}

	if (itemId && !track.items.includes(itemId)) {
		throw new Error(
			`Comic edit layer ${layerId} ${label} track ${trackId} does not contain item ${itemId}`,
		);
	}

	if (track.role !== undefined && track.role !== role) {
		throw new Error(
			`Comic edit layer ${layerId} ${label} track ${trackId} has role ${track.role}, expected ${role}`,
		);
	}
};

const validateComicEditLayerReferences = (
	state: UndoableState,
	layers: ComicEditLayers | undefined,
) => {
	if (!layers) {
		return;
	}

	for (const layer of Object.values(layers)) {
		const source = imageAsset(state.assets, layer.sourceAssetId);
		if (
			source &&
			(source.width !== layer.sourceCanvas.width ||
				source.height !== layer.sourceCanvas.height)
		) {
			throw new Error(
				`Comic edit layer ${layer.id} source asset dimensions do not match its source canvas`,
			);
		}

		const mask = imageAsset(state.assets, layer.maskAssetId);
		if (
			mask &&
			(mask.width !== layer.sourceCanvas.width ||
				mask.height !== layer.sourceCanvas.height)
		) {
			throw new Error(
				`Comic edit layer ${layer.id} mask dimensions do not match its source canvas`,
			);
		}

		const cutout = imageAsset(state.assets, layer.cutoutAssetId);
		if (
			cutout &&
			(cutout.width !== Math.round(layer.bounds.width) ||
				cutout.height !== Math.round(layer.bounds.height))
		) {
			throw new Error(
				`Comic edit layer ${layer.id} cutout dimensions do not match its bounds`,
			);
		}

		const cleanPlate = imageAsset(state.assets, layer.cleanPlateAssetId);
		if (
			cleanPlate &&
			(cleanPlate.width !== layer.sourceCanvas.width ||
				cleanPlate.height !== layer.sourceCanvas.height)
		) {
			throw new Error(
				`Comic edit layer ${layer.id} clean plate dimensions do not match its source canvas`,
			);
		}

		const sourceItem = item(state.items, layer.sourceItemId);
		if (layer.sourceItemId && (!sourceItem || sourceItem.type !== 'image')) {
			throw new Error(
				`Comic edit layer ${layer.id} source item ${layer.sourceItemId} is missing or not an image`,
			);
		}
		if (
			sourceItem?.type === 'image' &&
			sourceItem.assetId !== layer.sourceAssetId
		) {
			throw new Error(
				`Comic edit layer ${layer.id} source item does not reference its source asset`,
			);
		}

		const cutoutItem = item(state.items, layer.cutoutItemId);
		if (layer.cutoutItemId && (!cutoutItem || cutoutItem.type !== 'image')) {
			throw new Error(
				`Comic edit layer ${layer.id} cutout item ${layer.cutoutItemId} is missing or not an image`,
			);
		}
		if (
			cutoutItem?.type === 'image' &&
			layer.cutoutAssetId &&
			cutoutItem.assetId !== layer.cutoutAssetId
		) {
			throw new Error(
				`Comic edit layer ${layer.id} cutout item does not reference its cutout asset`,
			);
		}

		const cleanPlateItem = item(state.items, layer.cleanPlateItemId);
		if (
			layer.cleanPlateItemId &&
			(!cleanPlateItem || cleanPlateItem.type !== 'image')
		) {
			throw new Error(
				`Comic edit layer ${layer.id} clean plate item ${layer.cleanPlateItemId} is missing or not an image`,
			);
		}
		if (
			cleanPlateItem?.type === 'image' &&
			layer.cleanPlateAssetId &&
			cleanPlateItem.assetId !== layer.cleanPlateAssetId
		) {
			throw new Error(
				`Comic edit layer ${layer.id} clean plate item does not reference its clean plate asset`,
			);
		}

		assertTrackReference({
			tracks: state.tracks,
			trackId: layer.sourceTrackId,
			itemId: layer.sourceItemId,
			role: 'source',
			layerId: layer.id,
			label: 'source',
		});
		assertTrackReference({
			tracks: state.tracks,
			trackId: layer.cutoutTrackId,
			itemId: layer.cutoutItemId,
			role: 'cutout',
			layerId: layer.id,
			label: 'cutout',
		});
		assertTrackReference({
			tracks: state.tracks,
			trackId: layer.cleanPlateTrackId,
			itemId: layer.cleanPlateItemId,
			role: 'clean-plate',
			layerId: layer.id,
			label: 'clean plate',
		});

		if (
			layer.cleanPlateStatus === 'ready' &&
			(!layer.cleanPlateAssetId ||
				!layer.cleanPlateItemId ||
				!layer.cleanPlateTrackId)
		) {
			throw new Error(
				`Comic edit layer ${layer.id} is ready without complete clean plate references`,
			);
		}

		if (layer.finalCompositionReady && layer.cleanPlateStatus !== 'ready') {
			throw new Error(
				`Comic edit layer ${layer.id} is final-ready without a ready clean plate`,
			);
		}
	}
};

const normalizeAdvancedProjectState = (
	advanced: AdvancedProjectState | undefined,
): AdvancedProjectState | undefined => {
	if (!advanced) {
		return undefined;
	}

	if (advanced.expressions !== undefined) {
		return advanced;
	}

	return {
		...advanced,
		expressions: {},
	};
};

export const normalizeUndoableState = (state: UndoableState): UndoableState => {
	const schemaVersion = state.schemaVersion ?? LEGACY_SCHEMA_VERSION;

	if (schemaVersion > COMIC_SCHEMA_VERSION) {
		throw new ComicEditorError({
			code: COMIC_ERROR_CODES.SCHEMA_TOO_NEW,
			message: `Schema version ${schemaVersion} is newer than supported version ${COMIC_SCHEMA_VERSION}`,
			retryable: false,
			status: 422,
		});
	}

	const normalizedItems = normalizeEditorStarterItemsRecord(state.items);
	const normalizedComicEditLayers = normalizeComicEditLayers(
		state.comicEditLayers,
	);
	const normalizedAdvanced = normalizeAdvancedProjectState(state.advanced);
	validateComicEditLayerReferences(state, normalizedComicEditLayers);
	const needsShots = state.shots === undefined;
	const needsComicEditLayers =
		state.comicEditLayers !== undefined &&
		normalizedComicEditLayers !== state.comicEditLayers;
	const needsAdvanced = normalizedAdvanced !== state.advanced;

	const normalizedState =
		!needsShots &&
		!needsComicEditLayers &&
		!needsAdvanced &&
		normalizedItems === state.items
			? state
			: ({
					...state,
					items: normalizedItems,
					shots: state.shots ?? [],
					...(normalizedAdvanced ? {advanced: normalizedAdvanced} : {}),
					...(state.comicEditLayers !== undefined
						? {comicEditLayers: normalizedComicEditLayers}
						: {}),
				} satisfies UndoableState);

	return migrateMotionToPropertyGraph(normalizedState).state;
};
