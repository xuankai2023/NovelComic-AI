import {createHash} from 'node:crypto';
import {createStoredZip, readStoredZip, type ZipEntry} from '../comic/zip';
import {hashDocument, migrateDocument, normalizeDocument, validateDocument, type AssetRecord, type DocumentState} from '../document';

export const WEB_PROJECT_PACKAGE_FORMAT = 'novelcomic-document-package' as const;
export const WEB_PROJECT_PACKAGE_VERSION = 1 as const;

export type ProjectPackageAsset = AssetRecord & {
	path: string;
	sha256: string;
};

export type ProjectPackageManifest = {
	format: typeof WEB_PROJECT_PACKAGE_FORMAT;
	packageVersion: typeof WEB_PROJECT_PACKAGE_VERSION;
	schemaVersion: 1;
	projectId: string;
	documentId: string;
	name: string;
	documentPath: 'document.json';
	contentHash: string;
	assets: ProjectPackageAsset[];
};

export type ProjectPackageAssetInput = {
	assetId: string;
	body: Uint8Array;
	path?: string;
};

export type ProjectPackageBuildResult = {
	body: Buffer;
	manifest: ProjectPackageManifest;
	warnings: string[];
};

export type ProjectPackageReadResult = {
	document: DocumentState;
	manifest: ProjectPackageManifest;
	assets: Map<string, Uint8Array>;
	report: {warnings: string[]; verifiedAssets: string[]};
};

export class ProjectPackageError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'ProjectPackageError';
	}
}

const clone = <T>(value: T): T => structuredClone(value);
const safePath = (value: string): string => {
	const path = value.replace(/\\/g, '/');
	if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..'))
		throw new ProjectPackageError('UNSAFE_PATH', `Unsafe package path: ${value}`);
	return path;
};
const digest = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex');
const defaultAssetPath = (asset: AssetRecord): string => {
	const name = asset.originalName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'asset.bin';
	return `assets/${asset.id}/${name}`;
};

const parseManifest = (value: unknown): ProjectPackageManifest => {
	if (!value || typeof value !== 'object') throw new ProjectPackageError('MANIFEST_INVALID', 'Project manifest must be an object');
	const manifest = value as Partial<ProjectPackageManifest>;
	if (manifest.format !== WEB_PROJECT_PACKAGE_FORMAT) throw new ProjectPackageError('FORMAT_UNSUPPORTED', 'Unsupported project package format');
	if (manifest.packageVersion !== WEB_PROJECT_PACKAGE_VERSION || manifest.schemaVersion !== 1) {
		if (Number(manifest.packageVersion ?? 0) > WEB_PROJECT_PACKAGE_VERSION || Number(manifest.schemaVersion ?? 0) > 1)
			throw new ProjectPackageError('SCHEMA_TOO_NEW', 'Project package was created by a newer editor');
		throw new ProjectPackageError('MANIFEST_INVALID', 'Unsupported project package version');
	}
	if (typeof manifest.projectId !== 'string' || typeof manifest.documentId !== 'string' || typeof manifest.name !== 'string' || manifest.documentPath !== 'document.json' || typeof manifest.contentHash !== 'string' || !Array.isArray(manifest.assets))
		throw new ProjectPackageError('MANIFEST_INVALID', 'Project manifest metadata is incomplete');
	const seen = new Set<string>();
	const assets = manifest.assets.map((asset) => {
		if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string' || typeof asset.path !== 'string' || typeof asset.sha256 !== 'string') throw new ProjectPackageError('MANIFEST_INVALID', 'Project asset entry is invalid');
		const path = safePath(asset.path);
		if (!path.startsWith('assets/')) throw new ProjectPackageError('MANIFEST_INVALID', `Asset ${asset.id} must live under assets/`);
		if (seen.has(asset.id) || seen.has(path)) throw new ProjectPackageError('MANIFEST_INVALID', 'Project asset ids and paths must be unique');
		seen.add(asset.id); seen.add(path);
		return clone({...asset, path}) as ProjectPackageAsset;
	});
	return {...manifest, assets} as ProjectPackageManifest;
};

export const buildProjectPackage = async ({document, assets = [], now = new Date(), strictAssets = true}: {document: DocumentState; assets?: readonly ProjectPackageAssetInput[]; now?: Date; strictAssets?: boolean}): Promise<ProjectPackageBuildResult> => {
	const errors = validateDocument(document).filter((issue) => issue.severity === 'error');
	if (errors.length) throw new ProjectPackageError('DOCUMENT_INVALID', errors[0]!.message);
	const normalized = normalizeDocument(document);
	const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
	const warnings: string[] = [];
	const manifestAssets: ProjectPackageAsset[] = [];
	const entries: ZipEntry[] = [{path: 'document.json', body: JSON.stringify(normalized)}];
	for (const asset of Object.values(normalized.assets).sort((a, b) => a.id.localeCompare(b.id))) {
		const input = byId.get(asset.id);
		if (!input) {
			const message = `Missing bytes for asset ${asset.id}`;
			if (strictAssets) throw new ProjectPackageError('ASSET_DATA_MISSING', message);
			warnings.push(message);
			continue;
		}
		const body = new Uint8Array(input.body);
		const path = safePath(input.path ?? defaultAssetPath(asset));
		if (!path.startsWith('assets/')) throw new ProjectPackageError('UNSAFE_PATH', `Asset ${asset.id} must live under assets/`);
		const entry = {...asset, path, sha256: digest(body)};
		manifestAssets.push(entry);
		entries.push({path, body: Buffer.from(body)});
	}
	const contentHash = await hashDocument(normalized);
	const manifest: ProjectPackageManifest = {
		format: WEB_PROJECT_PACKAGE_FORMAT,
		packageVersion: WEB_PROJECT_PACKAGE_VERSION,
		schemaVersion: 1,
		projectId: normalized.projectId,
		documentId: normalized.documentId,
		name: normalized.name,
		documentPath: 'document.json',
		contentHash,
		assets: manifestAssets,
	};
	entries.unshift({path: 'manifest.json', body: JSON.stringify(manifest)});
	void now;
	return {body: createStoredZip(entries, now), manifest, warnings};
};

export const readProjectPackage = async (archive: Uint8Array): Promise<ProjectPackageReadResult> => {
	let entries;
	try { entries = readStoredZip(Buffer.from(archive)); } catch (error) { throw new ProjectPackageError('PACKAGE_CORRUPT', error instanceof Error ? error.message : 'Package archive is corrupt'); }
	const byPath = new Map<string, Uint8Array>();
	for (const entry of entries) {
		const path = safePath(entry.path);
		if (byPath.has(path)) throw new ProjectPackageError('PACKAGE_CORRUPT', `Duplicate package entry: ${path}`);
		byPath.set(path, new Uint8Array(entry.body));
	}
	const manifestBytes = byPath.get('manifest.json');
	const documentBytes = byPath.get('document.json');
	if (!manifestBytes || !documentBytes) throw new ProjectPackageError('PACKAGE_CORRUPT', 'manifest.json and document.json are required');
	let manifest: ProjectPackageManifest;
	let source: unknown;
	try { manifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes))); source = JSON.parse(new TextDecoder().decode(documentBytes)); } catch (error) { if (error instanceof ProjectPackageError) throw error; throw new ProjectPackageError('PACKAGE_CORRUPT', error instanceof Error ? error.message : 'Package JSON is invalid'); }
	if (manifest.projectId !== (source as {projectId?: unknown})?.projectId || manifest.documentId !== (source as {documentId?: unknown})?.documentId) throw new ProjectPackageError('MANIFEST_MISMATCH', 'Manifest does not describe document.json');
	let document: DocumentState;
	try { document = normalizeDocument(migrateDocument(source).document); } catch (error) { throw new ProjectPackageError('DOCUMENT_INVALID', error instanceof Error ? error.message : 'Document is invalid'); }
	if (await hashDocument(document) !== manifest.contentHash) throw new ProjectPackageError('CONTENT_HASH_MISMATCH', 'Document content hash does not match manifest');
	const assets = new Map<string, Uint8Array>();
	const warnings: string[] = [];
	for (const entry of manifest.assets) {
		const bytes = byPath.get(entry.path);
		if (!bytes) throw new ProjectPackageError('ASSET_MISSING', `Package is missing asset ${entry.id}`);
		if (digest(bytes) !== entry.sha256) throw new ProjectPackageError('ASSET_HASH_MISMATCH', `Asset ${entry.id} is corrupted`);
		assets.set(entry.id, bytes);
	}
	for (const asset of Object.values(document.assets)) if (!assets.has(asset.id)) throw new ProjectPackageError('ASSET_MISSING', `Document references missing asset ${asset.id}`);
	return {document: clone(document), manifest, assets, report: {warnings, verifiedAssets: [...assets.keys()]}};
};
