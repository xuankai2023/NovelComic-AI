import {createHash} from 'node:crypto';
import {createEmptyDocument, createPixelLayer} from '../document/defaults';
import {normalizeDocument, type DocumentState, type LayerNode} from '../document';

export type PsdHeader = {version: 1 | 2; channels: number; height: number; width: number; depth: 8 | 16 | 32; colorMode: number};
export type PsdLayerInput = {id: string; name: string; bytes?: Uint8Array; visible?: boolean; opacity?: number; bounds?: {x: number; y: number; width: number; height: number}; text?: {content: string; fontFamily?: string; fontSize?: number}; shape?: {shape: 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'line'; fill?: {r: number; g: number; b: number; a?: number}; strokeWidth?: number}};
export type PsdConversionResult = {document: DocumentState; assets: Map<string, Uint8Array>; report: {warnings: string[]; unsupported: string[]; converted: string[]}};
type PsdReport = PsdConversionResult['report'];

export class PsdAdapterError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'PsdAdapterError'; } }

export const parsePsdHeader = (input: Uint8Array): PsdHeader => {
	if (input.length < 26 || String.fromCharCode(...input.slice(0, 4)) !== '8BPS') throw new PsdAdapterError('PSD_SIGNATURE_INVALID', 'Not a PSD/PSB file');
	const view = new DataView(input.buffer, input.byteOffset); const version = view.getUint16(4, false); if (version !== 1 && version !== 2) throw new PsdAdapterError('PSD_VERSION_UNSUPPORTED', 'Only PSD and PSB are supported');
	const channels = view.getUint16(12, false); const height = view.getUint32(14, false); const width = view.getUint32(18, false); const depth = view.getUint16(22, false); const colorMode = view.getUint16(24, false);
	if (colorMode !== 3) throw new PsdAdapterError('PSD_COLOR_MODE_UNSUPPORTED', 'Only 8-bit RGB PSD/PSB files are editable');
	if (depth !== 8) throw new PsdAdapterError('PSD_BIT_DEPTH_UNSUPPORTED', 'Only 8-bit RGB PSD/PSB files are editable');
	return {version: version as 1 | 2, channels, height, width, depth: 8, colorMode};
};

export const convertPsdLayers = ({header, layers, projectId, name = 'Imported PSD'}: {header: PsdHeader; layers: readonly PsdLayerInput[]; projectId: string; name?: string}): PsdConversionResult => {
	if (header.colorMode !== 3 || header.depth !== 8) throw new PsdAdapterError('PSD_FORMAT_UNSUPPORTED', 'Only 8-bit RGB PSD/PSB files are editable');
	const document = createEmptyDocument({projectId, name, width: header.width, height: header.height}); const assets = new Map<string, Uint8Array>(); const report: PsdReport = {warnings: [], unsupported: [], converted: []}; const nodes: Record<string, LayerNode> = {};
	for (const [index, source] of layers.entries()) {
		const bounds = source.bounds ?? {x: 0, y: 0, width: header.width, height: header.height};
		let layer: LayerNode;
		if (source.text) { const base = createPixelLayer(`psd-text-${source.id}`, source.name, bounds.width, bounds.height); layer = {...base, id: source.id, kind: 'text', transform: {...base.transform, originX: bounds.x, originY: bounds.y}, content: {kind: 'text', text: source.text.content, fontFamily: source.text.fontFamily ?? 'sans-serif', fontSize: source.text.fontSize ?? 48, color: {r: 0, g: 0, b: 0, a: 1}, align: 'left', lineHeight: 1.2, letterSpacing: 0} as Extract<LayerNode['content'], {kind: 'text'}>}; report.converted.push(`${source.id}:text`);
		} else if (source.shape) { const base = createPixelLayer(`psd-shape-${source.id}`, source.name, bounds.width, bounds.height); layer = {...base, id: source.id, kind: 'shape', transform: {...base.transform, originX: bounds.x, originY: bounds.y}, content: {kind: 'shape', shape: source.shape.shape, fill: {...(source.shape.fill ?? {r: 0, g: 0, b: 0}), a: source.shape.fill?.a ?? 1}, strokeWidth: source.shape.strokeWidth ?? 0} as Extract<LayerNode['content'], {kind: 'shape'}>}; report.converted.push(`${source.id}:shape`);
		} else {
			if (!source.bytes) { report.unsupported.push(`${source.id}:pixel-data`); report.warnings.push(`${source.id} has no decoded pixel bytes and was omitted`); continue; }
			const assetId = `psd-${source.id}`; const body = new Uint8Array(source.bytes); assets.set(assetId, body); document.assets[assetId] = {id: assetId, kind: 'raster', originalName: `${source.id}.png`, mimeType: 'image/png', byteSize: body.byteLength, objectKey: `assets/${assetId}.png`, contentHash: createHash('sha256').update(body).digest('hex')}; layer = createPixelLayer(assetId, source.name, bounds.width, bounds.height); layer.id = source.id; layer.transform.originX = bounds.x; layer.transform.originY = bounds.y;
		}
		layer.order = index; layer.visible = source.visible !== false; layer.opacity = source.opacity ?? 1; nodes[layer.id] = layer;
	}
	document.layers = nodes; document.rootLayerIds = Object.values(nodes).sort((a, b) => a.order - b.order).map((layer) => layer.id); return {document: normalizeDocument(document), assets, report};
};
