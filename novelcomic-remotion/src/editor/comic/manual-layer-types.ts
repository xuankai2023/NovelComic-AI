import type {ComicLayerSemantic, LayerAnchor, LayerBounds} from './types';

export type ManualLayerPoint = {
	x: number;
	y: number;
};

export type ManualLayerCanvas = {
	width: number;
	height: number;
};

export const CLEAN_PLATE_STATUSES = [
	'missing',
	'processing',
	'ready',
	'failed',
] as const;

export type CleanPlateStatus = (typeof CLEAN_PLATE_STATUSES)[number];

/**
 * Metadata for a user-authored comic layer.
 *
 * Pixel assets stay in the asset store. This record only keeps the
 * relationship between the source, mask, derived cutout, and clean plate.
 */
export type ComicEditLayer = {
	id: string;
	name: string;
	semantic: ComicLayerSemantic;
	sourceAssetId: string;
	sourceItemId?: string;
	sourceTrackId?: string;
	shotId?: string;
	sourceCanvas: ManualLayerCanvas;
	bounds: LayerBounds;
	anchor?: LayerAnchor;
	polygon?: ManualLayerPoint[];
	maskAssetId?: string;
	cutoutAssetId?: string;
	cleanPlateAssetId?: string;
	cutoutItemId?: string;
	cutoutTrackId?: string;
	cleanPlateItemId?: string;
	cleanPlateTrackId?: string;
	/**
	 * Optional for legacy input. Normalization always supplies this field.
	 */
	cleanPlateStatus?: CleanPlateStatus;
	/**
	 * Optional for legacy input. Normalization always supplies this field.
	 */
	finalCompositionReady?: boolean;
	visible: boolean;
	locked: boolean;
	opacity: number;
	zIndex: number;
	matte?: {
		type: 'still-mask' | 'object-matte' | 'roto-brush';
		maskAssetId?: string;
		frozen?: boolean;
		properties: {
			feather: number;
			contrast: number;
			shiftEdge: number;
			reduceChatter?: number;
			refineEdgeRadius?: number;
		};
	};
};

export type ComicEditLayers = Record<string, ComicEditLayer>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null;
};

const isFiniteNumber = (value: unknown): value is number => {
	return typeof value === 'number' && Number.isFinite(value);
};

const isPositiveInteger = (value: unknown): value is number => {
	return Number.isInteger(value) && (value as number) > 0;
};

const isNonEmptyString = (value: unknown): value is string => {
	return typeof value === 'string' && value.trim().length > 0;
};

const isCleanPlateStatus = (value: unknown): value is CleanPlateStatus => {
	return (CLEAN_PLATE_STATUSES as readonly string[]).includes(value as string);
};

const readOptionalString = (
	value: unknown,
	label: string,
): string | undefined => {
	if (value === undefined) {
		return undefined;
	}

	if (!isNonEmptyString(value)) {
		throw new Error(`${label} must be a non-empty string`);
	}

	return value;
};

const isComicLayerSemantic = (value: unknown): value is ComicLayerSemantic => {
	return (
		value === 'background' ||
		value === 'foreground' ||
		value === 'body' ||
		value === 'head' ||
		value === 'arm-left' ||
		value === 'arm-right' ||
		value === 'hair' ||
		value === 'eye-open' ||
		value === 'eye-closed' ||
		value === 'mouth-closed' ||
		value === 'mouth-half' ||
		value === 'mouth-open' ||
		value === 'effect' ||
		value === 'other'
	);
};

const readMatte = (value: unknown, key: string): ComicEditLayer['matte'] => {
	if (value === undefined) return undefined;
	if (!isRecord(value) || (value.type !== 'still-mask' && value.type !== 'object-matte' && value.type !== 'roto-brush') || !isRecord(value.properties)) {
		throw new Error(`Comic edit layer ${key} has an invalid matte`);
	}
	const feather = value.properties.feather;
	const contrast = value.properties.contrast;
	const shiftEdge = value.properties.shiftEdge;
	if (!isFiniteNumber(feather) || !isFiniteNumber(contrast) || !isFiniteNumber(shiftEdge)) throw new Error(`Comic edit layer ${key} has invalid matte properties`);
	const maskAssetId = readOptionalString(value.maskAssetId, `Comic edit layer ${key} matte maskAssetId`);
	return {
		type: value.type, maskAssetId, frozen: typeof value.frozen === 'boolean' ? value.frozen : undefined,
		properties: {
			feather, contrast, shiftEdge,
			...(isFiniteNumber(value.properties.reduceChatter) ? {reduceChatter: value.properties.reduceChatter} : {}),
			...(isFiniteNumber(value.properties.refineEdgeRadius) ? {refineEdgeRadius: value.properties.refineEdgeRadius} : {}),
		},
	};
};

const assertValidLayer = (key: string, value: unknown): ComicEditLayer => {
	if (!isRecord(value)) {
		throw new Error(`Comic edit layer ${key} must be an object`);
	}

	const id = value.id ?? key;
	if (!isNonEmptyString(id) || id !== key) {
		throw new Error(`Comic edit layer ${key} must have a matching id`);
	}

	const name = value.name ?? id;
	if (!isNonEmptyString(name)) {
		throw new Error(`Comic edit layer ${key} must have a name`);
	}

	if (!isComicLayerSemantic(value.semantic)) {
		throw new Error(`Comic edit layer ${key} has an invalid semantic`);
	}

	if (!isNonEmptyString(value.sourceAssetId)) {
		throw new Error(`Comic edit layer ${key} must reference a source asset`);
	}

	const sourceCanvas = value.sourceCanvas;
	if (
		!isRecord(sourceCanvas) ||
		!isPositiveInteger(sourceCanvas.width) ||
		!isPositiveInteger(sourceCanvas.height)
	) {
		throw new Error(`Comic edit layer ${key} has an invalid source canvas`);
	}

	const bounds = value.bounds;
	if (
		!isRecord(bounds) ||
		!isFiniteNumber(bounds.x) ||
		!isFiniteNumber(bounds.y) ||
		!isFiniteNumber(bounds.width) ||
		!isFiniteNumber(bounds.height) ||
		bounds.x < 0 ||
		bounds.y < 0 ||
		bounds.width <= 0 ||
		bounds.height <= 0 ||
		bounds.x + bounds.width > sourceCanvas.width ||
		bounds.y + bounds.height > sourceCanvas.height
	) {
		throw new Error(
			`Comic edit layer ${key} has bounds outside its source canvas`,
		);
	}

	const anchor = value.anchor;
	if (anchor !== undefined) {
		if (
			!isRecord(anchor) ||
			!isFiniteNumber(anchor.x) ||
			!isFiniteNumber(anchor.y) ||
			anchor.x < 0 ||
			anchor.x > 1 ||
			anchor.y < 0 ||
			anchor.y > 1
		) {
			throw new Error(`Comic edit layer ${key} has an invalid anchor`);
		}
	}
	const normalizedAnchor =
		anchor === undefined
			? undefined
			: {x: anchor.x as number, y: anchor.y as number};

	const polygon = value.polygon;
	if (polygon !== undefined) {
		if (!Array.isArray(polygon) || polygon.length < 3) {
			throw new Error(
				`Comic edit layer ${key} polygon needs at least 3 points`,
			);
		}

		for (const point of polygon) {
			if (
				!isRecord(point) ||
				!isFiniteNumber(point.x) ||
				!isFiniteNumber(point.y) ||
				point.x < 0 ||
				point.y < 0 ||
				point.x > sourceCanvas.width ||
				point.y > sourceCanvas.height
			) {
				throw new Error(
					`Comic edit layer ${key} has a polygon point outside its canvas`,
				);
			}
		}
	}

	const shotId = readOptionalString(
		value.shotId,
		`Comic edit layer ${key} shotId`,
	);
	const sourceItemId = readOptionalString(
		value.sourceItemId,
		`Comic edit layer ${key} sourceItemId`,
	);
	const sourceTrackId = readOptionalString(
		value.sourceTrackId,
		`Comic edit layer ${key} sourceTrackId`,
	);
	const maskAssetId = readOptionalString(
		value.maskAssetId,
		`Comic edit layer ${key} maskAssetId`,
	);
	const cutoutAssetId = readOptionalString(
		value.cutoutAssetId,
		`Comic edit layer ${key} cutoutAssetId`,
	);
	const cleanPlateAssetId = readOptionalString(
		value.cleanPlateAssetId,
		`Comic edit layer ${key} cleanPlateAssetId`,
	);
	const cutoutItemId = readOptionalString(
		value.cutoutItemId,
		`Comic edit layer ${key} cutoutItemId`,
	);
	const cutoutTrackId = readOptionalString(
		value.cutoutTrackId,
		`Comic edit layer ${key} cutoutTrackId`,
	);
	const cleanPlateItemId = readOptionalString(
		value.cleanPlateItemId,
		`Comic edit layer ${key} cleanPlateItemId`,
	);
	const cleanPlateTrackId = readOptionalString(
		value.cleanPlateTrackId,
		`Comic edit layer ${key} cleanPlateTrackId`,
	);
	const cleanPlateStatus = value.cleanPlateStatus ?? 'missing';
	if (!isCleanPlateStatus(cleanPlateStatus)) {
		throw new Error(
			`Comic edit layer ${key} has an invalid clean plate status`,
		);
	}

	const hasCleanPlateReferences = Boolean(
		cleanPlateAssetId && cleanPlateItemId && cleanPlateTrackId,
	);
	const finalCompositionReady =
		value.finalCompositionReady ??
		(cleanPlateStatus === 'ready' && hasCleanPlateReferences);
	if (typeof finalCompositionReady !== 'boolean') {
		throw new Error(
			`Comic edit layer ${key} finalCompositionReady must be a boolean`,
		);
	}
	if (
		finalCompositionReady &&
		(cleanPlateStatus !== 'ready' || !hasCleanPlateReferences)
	) {
		throw new Error(
			`Comic edit layer ${key} cannot be final-ready without a ready clean plate`,
		);
	}

	const opacity = value.opacity ?? 1;
	if (!isFiniteNumber(opacity) || opacity < 0 || opacity > 1) {
		throw new Error(`Comic edit layer ${key} opacity must be between 0 and 1`);
	}

	const rawZIndex = value.zIndex ?? 0;
	if (!Number.isInteger(rawZIndex)) {
		throw new Error(`Comic edit layer ${key} zIndex must be an integer`);
	}
	const zIndex = rawZIndex as number;
	const matte = readMatte(value.matte, key);

	if (value.visible !== undefined && typeof value.visible !== 'boolean') {
		throw new Error(`Comic edit layer ${key} visible must be a boolean`);
	}

	if (value.locked !== undefined && typeof value.locked !== 'boolean') {
		throw new Error(`Comic edit layer ${key} locked must be a boolean`);
	}

	return {
		id,
		name,
		semantic: value.semantic,
		sourceAssetId: value.sourceAssetId,
		sourceItemId,
		sourceTrackId,
		shotId,
		sourceCanvas: {
			width: sourceCanvas.width,
			height: sourceCanvas.height,
		},
		bounds: {
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
		},
		anchor: normalizedAnchor,
		polygon: polygon?.map((point) => ({x: point.x, y: point.y})),
		maskAssetId,
		cutoutAssetId,
		cleanPlateAssetId,
		cutoutItemId,
		cutoutTrackId,
		cleanPlateItemId,
		cleanPlateTrackId,
		cleanPlateStatus,
		finalCompositionReady,
		visible: value.visible ?? true,
		locked: value.locked ?? false,
		opacity,
		zIndex,
		matte,
	};
};

export const normalizeComicEditLayers = (
	value: unknown,
): ComicEditLayers | undefined => {
	if (value === undefined) {
		return undefined;
	}

	if (!isRecord(value)) {
		throw new Error('comicEditLayers must be an object');
	}

	const normalized: ComicEditLayers = {};
	for (const [key, layer] of Object.entries(value)) {
		normalized[key] = assertValidLayer(key, layer);
	}

	return normalized;
};

export const cloneComicEditLayers = (
	layers: ComicEditLayers | undefined,
): ComicEditLayers | undefined => {
	if (!layers) {
		return undefined;
	}

	return Object.fromEntries(
		Object.entries(layers).map(([id, layer]) => {
			return [
				id,
				{
					...layer,
					sourceCanvas: {...layer.sourceCanvas},
					bounds: {...layer.bounds},
					anchor: layer.anchor ? {...layer.anchor} : undefined,
					polygon: layer.polygon?.map((point) => ({...point})),
				},
			];
		}),
	);
};

export const collectAssetIdsFromComicEditLayers = (
	layers: ComicEditLayers | undefined,
): string[] => {
	if (!layers) {
		return [];
	}

	const assetIds: string[] = [];
	for (const layer of Object.values(layers)) {
		for (const assetId of [
			layer.sourceAssetId,
			layer.maskAssetId,
			layer.cutoutAssetId,
			layer.cleanPlateAssetId,
		]) {
			if (assetId && !assetIds.includes(assetId)) {
				assetIds.push(assetId);
			}
		}
	}

	return assetIds;
};
