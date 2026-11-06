import {createHash} from 'node:crypto';
import type {UndoableState} from '../state/types';
import {projectContentHash} from './content-hash';
import type {DeliveryPackageManifest} from './types';
import {readStoredZip} from './zip';

export type DeliveryPackageVerification = {
	valid: boolean;
	deliveryStatus: 'delivery-complete' | 'delivery-incomplete';
	project: unknown;
	manifest: DeliveryPackageManifest;
	checkedFiles: number;
	missingFiles: string[];
	failures: string[];
	warnings: string[];
};

const sha256 = (body: Buffer): string =>
	createHash('sha256').update(body).digest('hex');

const parseJson = (body: Buffer, label: string): unknown => {
	try {
		return JSON.parse(body.toString('utf8')) as unknown;
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
};

const isManifest = (value: unknown): value is DeliveryPackageManifest => {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as Partial<DeliveryPackageManifest>;
	return (
		candidate.schemaVersion === 1 &&
		typeof candidate.projectId === 'string' &&
		Array.isArray(candidate.files) &&
		Array.isArray(candidate.batches) &&
		Array.isArray(candidate.playOrder)
	);
};

const isRequiredMissingPath = (project: UndoableState, path: string): boolean => {
	if (!path.startsWith('missing/')) return true;
	const category = path.slice('missing/'.length);
	if (category === 'project' || category === 'preview') return false;
	if (category === 'layer') {
		return Object.keys(project.comicEditLayers ?? {}).length > 0;
	}
	if (category === 'audio') {
		return Object.values(project.assets).some((asset) => asset.type === 'audio');
	}
	if (category === 'subtitle') {
		return (
			Object.values(project.assets).some((asset) => asset.type === 'caption') ||
			Object.values(project.items).some((item) => item.type === 'captions')
		);
	}
	if (category === 'source') {
		return Object.values(project.assets).some(
			(asset) => asset.type !== 'audio' && asset.type !== 'caption',
		);
	}
	return true;
};

export const verifyDeliveryPackage = (
	archive: Buffer,
): DeliveryPackageVerification => {
	const entries = readStoredZip(archive);
	const byPath = new Map(entries.map((entry) => [entry.path, entry.body]));
	const manifestBody = byPath.get('manifest.json');
	const projectBody = byPath.get('project/project.json');
	if (!manifestBody || !projectBody) {
		throw new Error(
			'Delivery package is missing manifest.json or project/project.json',
		);
	}

	const parsedManifest = parseJson(manifestBody, 'manifest.json');
	if (!isManifest(parsedManifest)) {
		throw new Error('Delivery package manifest has an unsupported format');
	}
	const project = parseJson(projectBody, 'project/project.json');
	const failures: string[] = [];
	const missingFiles: string[] = [];
	const warnings: string[] = [];
	let checkedFiles = 0;
	const fullVideo = parsedManifest.files.find(
		(file) => file.path === 'final-video/full.mp4',
	);

	if (
		!project ||
		typeof project !== 'object' ||
		parsedManifest.projectContentHash !==
			projectContentHash(project as UndoableState)
	) {
		failures.push('Project content hash does not match manifest');
	}
	if (
		parsedManifest.inputContentHash &&
		parsedManifest.inputContentHash !== parsedManifest.projectContentHash
	) {
		failures.push('Input snapshot content hash does not match packaged project');
	}

	for (const file of parsedManifest.files) {
		const body = byPath.get(file.path);
		if (!body) {
			if (file.missingReason) {
				missingFiles.push(file.path);
				continue;
			}
			failures.push(`Missing packaged file ${file.path}`);
			continue;
		}

		if (file.checksum) {
			checkedFiles += 1;
			const actual = sha256(body);
			if (actual !== file.checksum) {
				failures.push(`Checksum mismatch for ${file.path}`);
			}
		} else {
			warnings.push(`No checksum recorded for ${file.path}`);
		}
	}

	const deliveryComplete =
		failures.length === 0 &&
		missingFiles.filter((path) =>
			isRequiredMissingPath(project as UndoableState, path),
		).length === 0 &&
		Boolean(parsedManifest.inputSnapshotId) &&
		Boolean(parsedManifest.preflightHash) &&
		parsedManifest.inputContentHash === parsedManifest.projectContentHash &&
		Boolean(fullVideo?.checksum) &&
		byPath.has('final-video/full.mp4');

	return {
		valid: failures.length === 0,
		deliveryStatus: deliveryComplete
			? 'delivery-complete'
			: 'delivery-incomplete',
		project,
		manifest: parsedManifest,
		checkedFiles,
		missingFiles,
		failures,
		warnings,
	};
};
