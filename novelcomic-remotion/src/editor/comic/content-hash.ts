import type {UndoableState} from '../state/types';

export const stableStringify = (value: unknown): string => {
	if (value === undefined) {
		return 'null';
	}

	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value) ?? 'null';
	}

	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(',')}}`;
};

export const hashContent = (value: unknown): string => {
	// Keep hashing synchronous and available in both the browser editor and
	// server-side delivery scripts. The canonical serialization is stable; this
	// compact non-cryptographic fingerprint is used for dedupe/version identity,
	// while delivery checksums continue to use their dedicated SHA-256 path.
	const serialized = stableStringify(value);
	let hash = 2166136261;
	for (const character of serialized) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return `${(hash >>> 0).toString(16).padStart(8, '0')}${serialized.length.toString(16).padStart(8, '0')}`;
};

export const projectContentHash = (project: UndoableState): string => {
	return hashContent({
		schemaVersion: project.schemaVersion ?? 1,
		fps: project.fps,
		compositionWidth: project.compositionWidth,
		compositionHeight: project.compositionHeight,
		tracks: project.tracks,
		items: project.items,
		assets: project.assets,
		deletedAssets: project.deletedAssets,
		shots: project.shots ?? [],
		comicEditLayers: project.comicEditLayers ?? {},
		voiceProfiles: project.voiceProfiles ?? {},
		layerGroups: project.layerGroups ?? {},
		adjustmentLayers: project.adjustmentLayers ?? {},
		penPaths: project.penPaths ?? {},
		advanced: project.advanced ?? null,
		propertyGraph: project.propertyGraph ?? null,
	});
};
