import {createHash} from 'node:crypto';
import {createEmptyDocument} from '../document/defaults';
import {normalizeDocument, validateDocument, type BlendMode, type DocumentColor, type DocumentState, type LayerNode} from '../document';

export const COMPOSITOR_FORMAT = 'com.compositor.project' as const;
export const COMPOSITOR_MAX_VERSION = 11;

export type CompManifestLayer = {
	id: string;
	name: string;
	imageFile?: string;
	maskFile?: string;
	maskEnabled?: boolean;
	maskLinked?: boolean;
	maskPlacement?: {origin: [number, number]; size: [number, number]; rotation?: number; flipX?: boolean; flipY?: boolean; sampling?: string};
	parentID?: string;
	isGroup?: boolean;
	isVisible?: boolean;
	opacity?: number;
	blendMode?: string;
	transform: {origin: [number, number]; size: [number, number]; rotation?: number; flipX?: boolean; flipY?: boolean; sampling?: string};
	adjustment?: Record<string, unknown>;
	text?: Record<string, unknown>;
	shape?: Record<string, unknown>;
};
export type CompManifest = {
	format: typeof COMPOSITOR_FORMAT;
	version: number;
	colorSpace: 'sRGB';
	documentID: string;
	width: number;
	height: number;
	resolution?: number;
	activeLayerID?: string;
	layers: CompManifestLayer[];
	guides?: Array<{id: string; axis: 'horizontal' | 'vertical'; position: number}>;
};
export type CompFiles = Readonly<Record<string, Uint8Array | string>>;
export type CompConversionReport = {warnings: string[]; unsupported: string[]; converted: string[]};

export class CompAdapterError extends Error {
	constructor(readonly code: string, message: string) { super(message); this.name = 'CompAdapterError'; }
}

const clone = <T>(value: T): T => structuredClone(value);
const bytes = (value: Uint8Array | string): Uint8Array => typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
const safeRelative = (value: string): string => {
	const path = value.replace(/\\/g, '/');
	if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new CompAdapterError('UNSAFE_PATH', `Unsafe .comp path: ${value}`);
	return path;
};
const blendModes: Record<string, BlendMode> = {
	Normal: 'normal', Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Darken: 'darken', Lighten: 'lighten', Difference: 'difference', 'Color Dodge': 'color-dodge', 'Color Burn': 'color-burn', 'Soft Light': 'soft-light', 'Hard Light': 'hard-light', Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity', Exclusion: 'exclusion',
};
const reverseBlendModes = Object.fromEntries(Object.entries(blendModes).map(([key, value]) => [value, key])) as Record<BlendMode, string>;
const toTransform = (transform: CompManifestLayer['transform'], fallbackWidth: number, fallbackHeight: number) => ({originX: transform.origin?.[0] ?? 0, originY: transform.origin?.[1] ?? 0, width: transform.size?.[0] ?? fallbackWidth, height: transform.size?.[1] ?? fallbackHeight, rotation: transform.rotation ?? 0, scaleX: transform.flipX ? -1 : 1, scaleY: transform.flipY ? -1 : 1, sampling: transform.sampling === 'Nearest' ? 'nearest' as const : transform.sampling === 'Smooth' ? 'smooth' as const : 'high' as const});
const toColor = (value: unknown, fallback: DocumentColor = {r: 0, g: 0, b: 0, a: 1}): DocumentColor => {
	if (!value || typeof value !== 'object') return fallback;
	const source = value as Record<string, unknown>;
	return {r: Number(source.red ?? source.r ?? 0) * (source.red !== undefined ? 255 : 1), g: Number(source.green ?? source.g ?? 0) * (source.green !== undefined ? 255 : 1), b: Number(source.blue ?? source.b ?? 0) * (source.blue !== undefined ? 255 : 1), a: Number(source.alpha ?? source.a ?? 1)};
};
const adjustment = (value: Record<string, unknown>): LayerNode['content'] => {
	const raw = String(value.kind ?? 'Invert');
	const kinds: Record<string, string> = {'Hue/Saturation': 'hue-saturation', Levels: 'levels', Curves: 'curves', Exposure: 'exposure', 'Gradient Map': 'gradient-map', Grain: 'grain', Invert: 'invert', 'Black & White': 'black-white', 'Color Balance': 'color-balance', 'Gaussian Blur': 'gaussian-blur', 'Motion Blur': 'motion-blur', 'Add Noise': 'add-noise'};
	const kind = kinds[raw] ?? 'invert';
	if (kind === 'invert') return {kind: 'invert'};
	if (kind === 'hue-saturation') return {kind, hue: Number(value.hue ?? 0), saturation: Number(value.saturation ?? 0), lightness: Number(value.lightness ?? 0), colorize: Boolean(value.colorize)};
	if (kind === 'exposure') return {kind, exposure: Number(value.exposure ?? 0), offset: Number(value.offset ?? 0), gamma: Number(value.gamma ?? 1)};
	if (kind === 'gaussian-blur') return {kind, radius: Number(value.blurRadius ?? 0)};
	if (kind === 'motion-blur') return {kind, angle: Number(value.motionAngle ?? 0), distance: Number(value.motionDistance ?? 0)};
	if (kind === 'add-noise') return {kind, amount: Number(value.noiseAmount ?? 0), gaussian: Boolean(value.noiseGaussian), monochromatic: Boolean(value.noiseMonochromatic), seed: Number(value.noiseSeed ?? 0)};
	if (kind === 'gradient-map') return {kind, shadows: toColor((value.gradientMapSettings as Record<string, unknown> | undefined)?.shadows), highlights: toColor((value.gradientMapSettings as Record<string, unknown> | undefined)?.highlights, {r: 255, g: 255, b: 255, a: 1}), reversed: Boolean((value.gradientMapSettings as Record<string, unknown> | undefined)?.reversed)};
	if (kind === 'grain') return {kind, amount: Number(value.amount ?? 0), monochromatic: Boolean(value.monochromatic), seed: Number(value.seed ?? 0)};
	if (kind === 'black-white') return {kind, settings: {reds: 0, yellows: 0, greens: 0, cyans: 0, blues: 0, magentas: 0}};
	if (kind === 'color-balance') return {kind, settings: {shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true}};
	return {kind: 'levels', channels: [{inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255}]};
};

export const parseCompManifest = (value: unknown): CompManifest => {
	if (!value || typeof value !== 'object') throw new CompAdapterError('MANIFEST_INVALID', '.comp manifest must be an object');
	const manifest = value as Partial<CompManifest>;
	if (manifest.format !== COMPOSITOR_FORMAT) throw new CompAdapterError('FORMAT_UNSUPPORTED', 'Not a Compositor project');
	if (!Number.isInteger(manifest.version) || manifest.version! > COMPOSITOR_MAX_VERSION) throw new CompAdapterError('SCHEMA_TOO_NEW', 'Compositor project version is newer than supported');
	if (manifest.version! < 1 || manifest.colorSpace !== 'sRGB' || typeof manifest.documentID !== 'string' || !Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) || !Array.isArray(manifest.layers)) throw new CompAdapterError('MANIFEST_INVALID', 'Compositor metadata is incomplete');
	const ids = new Set<string>();
	for (const layer of manifest.layers) {
		if (!layer || typeof layer !== 'object' || typeof layer.id !== 'string' || ids.has(layer.id)) throw new CompAdapterError('MANIFEST_INVALID', 'Layer ids must be unique');
		ids.add(layer.id);
		if (layer.imageFile) safeRelative(`images/${layer.imageFile}`);
		if (layer.maskFile) safeRelative(`images/${layer.maskFile}`);
		if (!layer.isGroup && !layer.imageFile && !layer.adjustment && !layer.text && !layer.shape) throw new CompAdapterError('MANIFEST_INVALID', `Layer ${layer.id} has no content`);
	}
	for (const layer of manifest.layers) if (layer.parentID && (!ids.has(layer.parentID) || !manifest.layers.find((candidate) => candidate.id === layer.parentID)?.isGroup)) throw new CompAdapterError('INVALID_PARENT', `Layer ${layer.id} has an invalid parent`);
	return clone(manifest as CompManifest);
};

export const compToDocument = ({files, projectId, name = 'Imported Compositor Project'}: {files: CompFiles; projectId: string; name?: string}): {document: DocumentState; assets: Map<string, Uint8Array>; report: CompConversionReport} => {
	const manifestEntry = files['manifest.json'];
	if (!manifestEntry) throw new CompAdapterError('MANIFEST_MISSING', 'manifest.json is required');
	let manifest: CompManifest;
	try { manifest = parseCompManifest(JSON.parse(new TextDecoder().decode(bytes(manifestEntry)))); } catch (error) { if (error instanceof CompAdapterError) throw error; throw new CompAdapterError('MANIFEST_INVALID', 'manifest.json is not valid JSON'); }
	const document = createEmptyDocument({documentId: manifest.documentID, projectId, name, width: manifest.width, height: manifest.height, resolution: manifest.resolution ?? 72});
	const assets = new Map<string, Uint8Array>();
	const report: CompConversionReport = {warnings: [], unsupported: [], converted: []};
	const layers: Record<string, LayerNode> = {};
	for (const [index, source] of manifest.layers.entries()) {
		const parentId = source.parentID ?? null;
		const transform = toTransform(source.transform, manifest.width, manifest.height);
		let layer: LayerNode;
		if (source.isGroup) layer = {id: source.id, name: source.name, kind: 'group', parentId, order: index, visible: source.isVisible !== false, locked: false, solo: false, opacity: source.opacity ?? 1, blendMode: 'normal', transform, content: {kind: 'group', group: true}};
		else if (source.adjustment) layer = {id: source.id, name: source.name, kind: 'adjustment', parentId, order: index, visible: source.isVisible !== false, locked: false, solo: false, opacity: source.opacity ?? 1, blendMode: blendModes[source.blendMode ?? 'Normal'] ?? 'normal', transform, content: adjustment(source.adjustment)} as LayerNode;
		else if (source.text) {
			const text = source.text;
			layer = {id: source.id, name: source.name, kind: 'text', parentId, order: index, visible: source.isVisible !== false, locked: false, solo: false, opacity: source.opacity ?? 1, blendMode: blendModes[source.blendMode ?? 'Normal'] ?? 'normal', transform, content: {kind: 'text', text: String(text.content ?? text.text ?? ''), fontFamily: String(text.fontName ?? 'sans-serif'), fontSize: Number(text.fontSize ?? 48), color: toColor(text.color, {r: 0, g: 0, b: 0, a: 1}), align: text.alignment === 'center' ? 'center' : text.alignment === 'right' ? 'right' : 'left', lineHeight: Number(text.lineHeight ?? 1.2), letterSpacing: Number(text.tracking ?? 0)}};
			report.converted.push(`${source.id}:text`);
		} else if (source.shape) {
			const shape = source.shape;
			layer = {id: source.id, name: source.name, kind: 'shape', parentId, order: index, visible: source.isVisible !== false, locked: false, solo: false, opacity: source.opacity ?? 1, blendMode: blendModes[source.blendMode ?? 'Normal'] ?? 'normal', transform, content: {kind: 'shape', shape: shape.kind === 'ellipse' ? 'ellipse' : shape.kind === 'line' ? 'line' : shape.cornerRadius ? 'rounded-rectangle' : 'rectangle', fill: toColor(shape, {r: 0, g: 0, b: 0, a: 1}), strokeWidth: Number(shape.lineWidth ?? 0), ...(shape.cornerRadius === undefined ? {} : {cornerRadius: Number(shape.cornerRadius)})}};
		} else {
			const imagePath = `images/${source.imageFile}`;
			const image = source.imageFile ? files[imagePath] : undefined;
			if (!image) throw new CompAdapterError('ASSET_MISSING', `Layer ${source.id} is missing ${imagePath}`);
			const body = bytes(image); const assetId = `comp-${source.id}`;
			const contentHash = createHash('sha256').update(body).digest('hex');
			assets.set(assetId, body);
			document.assets[assetId] = {id: assetId, kind: 'raster', originalName: source.imageFile!, mimeType: 'image/png', byteSize: body.byteLength, objectKey: imagePath, contentHash};
			layer = {id: source.id, name: source.name, kind: 'pixel', parentId, order: index, visible: source.isVisible !== false, locked: false, solo: false, opacity: source.opacity ?? 1, blendMode: blendModes[source.blendMode ?? 'Normal'] ?? 'normal', transform, content: {kind: 'pixel', assetId}};
		}
		if (source.maskFile) {
			const maskPath = `images/${source.maskFile}`; const mask = files[maskPath];
			if (!mask) throw new CompAdapterError('ASSET_MISSING', `Layer ${source.id} is missing ${maskPath}`);
			const body = bytes(mask); const assetId = `comp-mask-${source.id}`; assets.set(assetId, body); document.assets[assetId] = {id: assetId, kind: 'mask', originalName: source.maskFile, mimeType: 'image/png', byteSize: body.byteLength, objectKey: maskPath, contentHash: createHash('sha256').update(body).digest('hex')}; layer.mask = {assetId, enabled: source.maskEnabled !== false, linkedToLayer: source.maskLinked !== false, invert: false, feather: 0, ...(source.maskPlacement ? {placement: toTransform(source.maskPlacement, transform.width, transform.height)} : {})};
		}
		layers[layer.id] = layer;
	}
	document.layers = layers; document.rootLayerIds = manifest.layers.filter((layer) => !layer.parentID).map((layer) => layer.id); document.guides = (manifest.guides ?? []).map((guide) => ({id: guide.id, orientation: guide.axis, position: guide.position}));
	const normalized = normalizeDocument(document); const errors = validateDocument(normalized).filter((issue) => issue.severity === 'error'); if (errors.length) throw new CompAdapterError('DOCUMENT_INVALID', errors[0]!.message);
	return {document: normalized, assets, report};
};

export const documentToComp = ({document, assets}: {document: DocumentState; assets: ReadonlyMap<string, Uint8Array>}): {files: Record<string, Uint8Array | string>; manifest: CompManifest; report: CompConversionReport} => {
	const normalized = normalizeDocument(document); const report: CompConversionReport = {warnings: [], unsupported: [], converted: []};
	const layers: CompManifestLayer[] = [];
	const orderedIds: string[] = [];
	const visit = (id: string) => { const layer = normalized.layers[id]; if (!layer) return; orderedIds.push(id); Object.values(normalized.layers).filter((child) => child.parentId === id).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).forEach((child) => visit(child.id)); };
	normalized.rootLayerIds.forEach(visit);
	for (const layer of Object.values(normalized.layers)) if (!orderedIds.includes(layer.id)) visit(layer.id);
	for (const id of orderedIds) {
		const layer = normalized.layers[id]; if (!layer) continue;
		const transform = {origin: [layer.transform.originX, layer.transform.originY] as [number, number], size: [layer.transform.width, layer.transform.height] as [number, number], rotation: layer.transform.rotation, flipX: layer.transform.scaleX < 0, flipY: layer.transform.scaleY < 0, sampling: layer.transform.sampling === 'nearest' ? 'Nearest' : layer.transform.sampling === 'smooth' ? 'Smooth' : 'High quality'};
		const target: CompManifestLayer = {id: layer.id, name: layer.name, parentID: layer.parentId ?? undefined, isGroup: layer.kind === 'group', isVisible: layer.visible, opacity: layer.opacity, blendMode: reverseBlendModes[layer.blendMode] ?? 'Normal', transform};
		if (layer.kind === 'pixel') { const content = layer.content as Extract<LayerNode['content'], {kind: 'pixel'}>; const asset = normalized.assets[content.assetId]; const body = assets.get(content.assetId); if (!asset || !body) throw new CompAdapterError('ASSET_MISSING', `Layer ${layer.id} asset is missing`); target.imageFile = `${layer.id}.png`; }
		if (layer.mask) { const body = assets.get(layer.mask.assetId); if (!body) throw new CompAdapterError('ASSET_MISSING', `Layer ${layer.id} mask is missing`); target.maskFile = `${layer.id}.mask.png`; target.maskEnabled = layer.mask.enabled; target.maskLinked = layer.mask.linkedToLayer; }
		if (layer.kind === 'adjustment') { target.adjustment = {kind: layer.content.kind}; report.converted.push(`${layer.id}:adjustment`); }
		if (layer.kind === 'text') { const content = layer.content as Extract<LayerNode['content'], {kind: 'text'}>; target.text = {content: content.text, fontName: content.fontFamily, fontSize: content.fontSize, color: content.color, alignment: content.align, lineHeight: content.lineHeight, tracking: content.letterSpacing}; }
		if (layer.kind === 'shape') { const content = layer.content as Extract<LayerNode['content'], {kind: 'shape'}>; target.shape = {kind: content.shape, ...content.fill, lineWidth: content.strokeWidth, ...(content.cornerRadius === undefined ? {} : {cornerRadius: content.cornerRadius})}; }
		layers.push(target);
	}
	const files: Record<string, Uint8Array | string> = {};
	for (const layer of layers) { const source = normalized.layers[layer.id]!; if (source.kind === 'pixel') { const content = source.content as Extract<LayerNode['content'], {kind: 'pixel'}>; files[`images/${layer.imageFile}`] = assets.get(content.assetId)!; } if (source.mask) files[`images/${layer.maskFile}`] = assets.get(source.mask.assetId)!; }
	const manifest: CompManifest = {format: COMPOSITOR_FORMAT, version: COMPOSITOR_MAX_VERSION, colorSpace: 'sRGB', documentID: normalized.documentId, width: normalized.width, height: normalized.height, resolution: normalized.resolution, layers, guides: normalized.guides.map((guide) => ({id: guide.id, axis: guide.orientation, position: guide.position}))};
	files['manifest.json'] = JSON.stringify(manifest, null, 2); return {files, manifest, report};
};
