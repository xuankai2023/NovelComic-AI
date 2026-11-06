import {DOCUMENT_LIMITS} from './limits';
import {BLEND_MODES, type DocumentColor, type DocumentIssue, type DocumentState, type LayerNode, type LayerEffects} from './types';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const issue = (code: string, path: string, message: string): DocumentIssue => ({severity: 'error', code, path, message});
const adjustmentKinds = new Set(['hue-saturation', 'levels', 'curves', 'exposure', 'gradient-map', 'grain', 'invert', 'black-white', 'color-balance', 'gaussian-blur', 'motion-blur', 'add-noise', 'camera-raw']);
const effectKinds: readonly (keyof LayerEffects)[] = ['stroke', 'dropShadow', 'colorOverlay', 'innerShadow', 'outerGlow', 'innerGlow'];
const validateColor = (value: unknown, path: string, out: DocumentIssue[]) => {
	if (!value || typeof value !== 'object') {
		out.push(issue('COLOR_INVALID', path, 'Color must be an RGBA object'));
		return;
	}
	const color = value as DocumentColor;
	if (![color.r, color.g, color.b].every((channel) => finite(channel) && channel >= 0 && channel <= 255) || !finite(color.a) || color.a < 0 || color.a > 1)
		out.push(issue('COLOR_INVALID', path, 'Color channels must be within RGBA bounds'));
};
const validateLayerContent = (layer: LayerNode, path: string, assets: Record<string, unknown>, out: DocumentIssue[]) => {
	const content = layer.content;
	if (layer.kind === 'adjustment') {
		if (!adjustmentKinds.has(content.kind)) out.push(issue('ADJUSTMENT_KIND_INVALID', `${path}.kind`, 'Unknown adjustment kind'));
		if (content.kind === 'camera-raw' && (!content.settings || typeof content.settings !== 'object')) out.push(issue('CAMERA_RAW_SETTINGS_INVALID', `${path}.settings`, 'Camera Raw settings are required'));
		return;
	}
	if (layer.kind === 'text' && content.kind === 'text') {
		if (typeof content.text !== 'string' || typeof content.fontFamily !== 'string' || !finite(content.fontSize) || content.fontSize <= 0 || !finite(content.lineHeight) || content.lineHeight <= 0 || !['left', 'center', 'right'].includes(content.align))
			out.push(issue('TEXT_CONTENT_INVALID', path, 'Text metadata is invalid'));
		validateColor(content.color, `${path}.color`, out);
		for (const [index, run] of (content.runs ?? []).entries()) {
			if (!Number.isInteger(run.start) || !Number.isInteger(run.end) || run.start < 0 || run.end < run.start || run.end > content.text.length)
				out.push(issue('TEXT_RUN_INVALID', `${path}.runs.${index}`, 'Text run bounds are invalid'));
			if (run.color) validateColor(run.color, `${path}.runs.${index}.color`, out);
		}
		return;
	}
	if (layer.kind === 'shape' && content.kind === 'shape') {
		if (!['rectangle', 'rounded-rectangle', 'ellipse', 'line'].includes(content.shape) || !finite(content.strokeWidth) || content.strokeWidth < 0 || (content.cornerRadius !== undefined && (!finite(content.cornerRadius) || content.cornerRadius < 0)))
			out.push(issue('SHAPE_CONTENT_INVALID', path, 'Shape metadata is invalid'));
		validateColor(content.fill, `${path}.fill`, out);
		if (content.stroke) validateColor(content.stroke, `${path}.stroke`, out);
		return;
	}
	if (layer.kind === 'pixel' && content.kind === 'pixel' && assets[content.assetId] && (assets[content.assetId] as {kind?: string}).kind !== 'raster')
		out.push(issue('PIXEL_ASSET_KIND_INVALID', `${path}.assetId`, 'Pixel layers require raster assets'));
};
const validateEffects = (effects: LayerEffects | undefined, path: string, out: DocumentIssue[]) => {
	if (!effects) return;
	for (const key of Object.keys(effects)) {
		if (!effectKinds.includes(key as keyof LayerEffects)) {
			out.push(issue('EFFECT_KIND_INVALID', `${path}.${key}`, 'Unknown layer effect'));
			continue;
		}
		const effect = effects[key as keyof LayerEffects];
		if (!effect || typeof effect.enabled !== 'boolean') out.push(issue('EFFECT_INVALID', `${path}.${key}`, 'Effect enabled state is required'));
		if (effect && 'color' in effect) validateColor(effect.color, `${path}.${key}.color`, out);
		if (effect && Object.entries(effect).some(([field, value]) => field !== 'color' && field !== 'enabled' && field !== 'position' && field !== 'blendMode' && (typeof value !== 'number' || !finite(value) || (field === 'opacity' && (value < 0 || value > 1)))))
			out.push(issue('EFFECT_PARAMETER_INVALID', `${path}.${key}`, 'Effect numeric parameters are invalid'));
	}
};
const validateFiniteTree = (value: unknown, path: string, out: DocumentIssue[]): void => {
	if (typeof value === 'number' && !Number.isFinite(value)) out.push(issue('NON_FINITE_NUMBER', path, 'Numbers must be finite'));
	if (Array.isArray(value)) value.forEach((entry, index) => validateFiniteTree(entry, `${path}.${index}`, out));
	else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => validateFiniteTree(entry, `${path}.${key}`, out));
};
export const validateDocument = (document: unknown): DocumentIssue[] => {
	const d = document as Partial<DocumentState>;
	const out: DocumentIssue[] = [];
	if (!d || typeof d !== 'object') return [issue('DOCUMENT_NOT_OBJECT', '', 'Document must be an object')];
	if (d.schemaVersion !== 1) out.push(issue(d.schemaVersion && d.schemaVersion > 1 ? 'SCHEMA_TOO_NEW' : 'SCHEMA_VERSION_INVALID', 'schemaVersion', 'Unsupported document schema version'));
	for (const field of ['documentId', 'projectId', 'name'] as const) if (typeof d[field] !== 'string' || !d[field]) out.push(issue('REQUIRED_FIELD', field, `${field} is required`));
	for (const field of ['width', 'height'] as const) if (!Number.isInteger(d[field]) || (d[field] as number) < 1 || (d[field] as number) > DOCUMENT_LIMITS[field === 'width' ? 'maxWidth' : 'maxHeight']) out.push(issue('CANVAS_SIZE_INVALID', field, `${field} must be an integer within 1..32768`));
	if (!finite(d.resolution) || d.resolution < 1 || d.resolution > DOCUMENT_LIMITS.maxResolution) out.push(issue('RESOLUTION_INVALID', 'resolution', 'resolution must be within 1..2400'));
	if (!Array.isArray(d.rootLayerIds) || !d.layers || typeof d.layers !== 'object' || !d.assets || typeof d.assets !== 'object') return [...out, issue('LAYER_TABLE_INVALID', 'layers', 'layers, assets and rootLayerIds are required')];
	const layers = d.layers as Record<string, LayerNode>; const ids = new Set(Object.keys(layers));
	if (Object.keys(layers).length > DOCUMENT_LIMITS.maxLayers) out.push(issue('LAYER_LIMIT_EXCEEDED', 'layers', 'Too many layers'));
	const roots = d.rootLayerIds as string[]; const orders = new Map<string | null, Set<number>>();
	if (new Set(roots).size !== roots.length) out.push(issue('ROOT_DUPLICATE', 'rootLayerIds', 'Root layer ids must be unique'));
	for (const root of roots) if (!ids.has(root)) out.push(issue('MISSING_LAYER', `rootLayerIds.${root}`, 'Root layer does not exist'));
	for (const [id, layer] of Object.entries(layers)) if (layer.parentId === null && !roots.includes(id)) out.push(issue('ROOT_MISSING', `layers.${id}`, 'Top-level layer must appear in rootLayerIds'));
	for (const [id, layer] of Object.entries(layers)) {
		if (layer.id !== id) out.push(issue('LAYER_ID_MISMATCH', `layers.${id}.id`, 'Layer key and id must match'));
		if (!['pixel', 'group', 'adjustment', 'text', 'shape'].includes(layer.kind)) out.push(issue('LAYER_KIND_INVALID', `layers.${id}.kind`, 'Unknown layer kind'));
		if (layer.parentId !== null && (!ids.has(layer.parentId) || layers[layer.parentId]?.kind !== 'group')) out.push(issue('INVALID_PARENT', `layers.${id}.parentId`, 'Parent must be an existing group'));
		if (roots.includes(id) && layer.parentId !== null) out.push(issue('ROOT_PARENT_INVALID', `layers.${id}.parentId`, 'Root layer must have a null parent'));
		const siblingKey = layer.parentId ?? null; const siblingOrders = orders.get(siblingKey) ?? new Set<number>(); if (siblingOrders.has(layer.order) || !Number.isInteger(layer.order) || layer.order < 0) out.push(issue('ORDER_INVALID', `layers.${id}.order`, 'Sibling order must be unique and non-negative')); siblingOrders.add(layer.order); orders.set(siblingKey, siblingOrders);
		if (!finite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) out.push(issue('OPACITY_INVALID', `layers.${id}.opacity`, 'Opacity must be within 0..1'));
		if (!BLEND_MODES.includes(layer.blendMode)) out.push(issue('BLEND_MODE_INVALID', `layers.${id}.blendMode`, 'Unknown blend mode'));
		if (!layer.transform || Object.values(layer.transform).some((v) => typeof v !== 'number' && typeof v !== 'string' || typeof v === 'number' && !finite(v)) || !['high', 'smooth', 'nearest'].includes(layer.transform.sampling)) out.push(issue('TRANSFORM_INVALID', `layers.${id}.transform`, 'Transform values and sampling must be valid'));
			validateFiniteTree(layer.content, `layers.${id}.content`, out);
			validateLayerContent(layer, `layers.${id}.content`, d.assets as Record<string, unknown>, out);
			validateEffects(layer.effects, `layers.${id}.effects`, out);
		if (layer.kind === 'pixel' && (layer.content.kind !== 'pixel' || !d.assets[layer.content.assetId])) out.push(issue('ASSET_REFERENCE_MISSING', `layers.${id}.content.assetId`, 'Pixel layer asset is missing'));
		if (layer.kind === 'group' && layer.content.kind !== 'group') out.push(issue('CONTENT_KIND_MISMATCH', `layers.${id}.content`, 'Group content is invalid'));
		if (layer.kind === 'adjustment' && ['pixel', 'group', 'text', 'shape'].includes(layer.content.kind)) out.push(issue('CONTENT_KIND_MISMATCH', `layers.${id}.content`, 'Adjustment layer content is invalid'));
		if (layer.kind === 'text' && layer.content.kind !== 'text') out.push(issue('CONTENT_KIND_MISMATCH', `layers.${id}.content`, 'Text layer content is invalid'));
		if (layer.kind === 'shape' && layer.content.kind !== 'shape') out.push(issue('CONTENT_KIND_MISMATCH', `layers.${id}.content`, 'Shape layer content is invalid'));
			if (layer.mask && !d.assets[layer.mask.assetId]) out.push(issue('MASK_ASSET_MISSING', `layers.${id}.mask.assetId`, 'Mask asset is missing'));
			if (layer.mask && (!finite(layer.mask.feather) || layer.mask.feather < 0 || typeof layer.mask.enabled !== 'boolean' || typeof layer.mask.linkedToLayer !== 'boolean' || typeof layer.mask.invert !== 'boolean')) out.push(issue('MASK_INVALID', `layers.${id}.mask`, 'Mask settings are invalid'));
		if (layer.liveMaskSourceId && (!ids.has(layer.liveMaskSourceId) || layer.liveMaskSourceId === id)) out.push(issue('LIVE_MASK_SOURCE_INVALID', `layers.${id}.liveMaskSourceId`, 'Live mask source is invalid'));
		if (layer.liveMask?.sourceLayerId && (!ids.has(layer.liveMask.sourceLayerId) || layer.liveMask.sourceLayerId === id)) out.push(issue('LIVE_MASK_SOURCE_INVALID', `layers.${id}.liveMask.sourceLayerId`, 'Live mask source is invalid'));
		let current: string | null = id; const seen = new Set<string>(); let depth = 0; while (current) { if (seen.has(current)) {out.push(issue('LAYER_CYCLE', `layers.${id}`, 'Layer parent cycle detected')); break;} seen.add(current); current = layers[current]?.parentId ?? null; if (++depth > DOCUMENT_LIMITS.maxDepth) {out.push(issue('LAYER_DEPTH_EXCEEDED', `layers.${id}`, 'Layer nesting is too deep')); break;} }
	}
	for (const [id, asset] of Object.entries(d.assets)) if (!finite(asset.byteSize) || asset.byteSize < 0 || asset.byteSize > DOCUMENT_LIMITS.maxAssetBytes) out.push(issue('ASSET_SIZE_INVALID', `assets.${id}.byteSize`, 'Asset size is invalid'));
	return out;
};
