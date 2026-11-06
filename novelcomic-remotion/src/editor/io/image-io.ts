import {createHash} from 'node:crypto';
import {createPixelLayer} from '../document/defaults';
import type {AssetRecord, DocumentState, LayerNode} from '../document';
import {detectFileType} from '../utils/detect-file-type';

export const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/heic', 'image/tiff', 'image/svg+xml'] as const;
export type SupportedImageMimeType = typeof SUPPORTED_IMAGE_MIME_TYPES[number];
export type ImageImportResult = {asset: AssetRecord; layer: LayerNode; bytes: Uint8Array; report: {format: string; warnings: string[]}};

const extensionMime = (name: string): SupportedImageMimeType | undefined => {
	const ext = name.toLowerCase().split('.').pop();
	return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'heic' || ext === 'heif' ? 'image/heic' : ext === 'tif' || ext === 'tiff' ? 'image/tiff' : ext === 'svg' ? 'image/svg+xml' : undefined;
};
const idFor = (bytes: Uint8Array) => `asset-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`;
const objectKeyFor = (id: string, name: string) => `assets/${id}/${name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;

export const importImageBytes = async ({name, bytes, mimeType}: {name: string; bytes: Uint8Array; mimeType?: string}): Promise<ImageImportResult> => {
	const blob = new Blob([new Uint8Array(bytes)], {type: mimeType ?? extensionMime(name) ?? 'application/octet-stream'});
	const detected = await detectFileType(blob);
	const format = extensionMime(name) ?? (detected.category === 'image' && detected.type === 'jpeg' ? 'image/jpeg' : detected.category === 'image' && detected.type === 'png' ? 'image/png' : undefined);
	if (!format || !SUPPORTED_IMAGE_MIME_TYPES.includes(format)) throw new Error(`Unsupported image format: ${name}`);
	const dimensions = detected.category === 'image' ? detected.dimensions : null;
	const id = idFor(bytes);
	const asset: AssetRecord = {id, kind: 'raster', originalName: name, mimeType: format, ...(dimensions ? dimensions : {}), byteSize: bytes.byteLength, objectKey: objectKeyFor(id, name), contentHash: createHash('sha256').update(bytes).digest('hex')};
	const layer = createPixelLayer(id, name, dimensions?.width ?? 1, dimensions?.height ?? 1);
	return {asset, layer, bytes: new Uint8Array(bytes), report: {format, warnings: dimensions ? [] : ['Image dimensions require browser decoding before placement']}};
};

export type ImageExportFormat = 'png' | 'jpeg';
export const exportDocumentImage = async ({document, format = 'png', render, quality = 0.92}: {document: DocumentState; format?: ImageExportFormat; render: (document: DocumentState) => Promise<Uint8Array> | Uint8Array; quality?: number}) => {
	if (format !== 'png' && format !== 'jpeg') throw new Error(`Unsupported export format: ${format}`);
	if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error('Image quality must be between 0 and 1');
	const bytes = new Uint8Array(await render(document));
	return {bytes, mimeType: format === 'png' ? 'image/png' : 'image/jpeg', filename: `${document.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'document'}.${format}`, quality};
};

export const copyMerged = exportDocumentImage;
