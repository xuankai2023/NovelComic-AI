import type {
	AdvancedProjectState,
	TrackMatteDefinition,
} from '../composition/types';

export type TrackMatteIssue = {
	layerId: string;
	message: string;
};

export const clampCoverage = (value: number): number =>
	Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export const lumaFromRgba = (
	red: number,
	green: number,
	blue: number,
): number =>
	clampCoverage(
		0.2126 * clampCoverage(red) +
			0.7152 * clampCoverage(green) +
			0.0722 * clampCoverage(blue),
	);

export const trackMatteCoverage = (
	matte: TrackMatteDefinition,
	alpha: number,
	luma: number,
): number => {
	const source = matte.type.startsWith('luma') ? luma : alpha;
	return clampCoverage(matte.type.endsWith('inverted') ? 1 - source : source);
};

export const applyTrackMatteCoverage = (
	targetAlpha: number,
	matte: TrackMatteDefinition,
	matteAlpha: number,
	matteLuma: number,
): number =>
	clampCoverage(
		clampCoverage(targetAlpha) *
			trackMatteCoverage(matte, matteAlpha, matteLuma),
	);

export const validateTrackMattes = (
	state: AdvancedProjectState,
	compositionId?: string,
): TrackMatteIssue[] => {
	const issues: TrackMatteIssue[] = [];
	const layers = Object.values(state.layers).filter(
		(layer) => !compositionId || layer.compositionId === compositionId,
	);
	const byId = new Map(layers.map((layer) => [layer.id, layer]));
	const allById = new Map(
		Object.values(state.layers).map((layer) => [layer.id, layer]),
	);

	for (const layer of layers) {
		const matte = layer.matte;
		if (!matte) continue;
		if (matte.layerId === layer.id) {
			issues.push({
				layerId: layer.id,
				message: 'Track Matte cannot reference its own layer.',
			});
			continue;
		}

		const matteLayer = allById.get(matte.layerId);
		if (!matteLayer || matteLayer.compositionId !== layer.compositionId) {
			issues.push({
				layerId: layer.id,
				message: `Track Matte layer ${matte.layerId} does not exist in the same composition.`,
			});
			continue;
		}

		const visited = new Set<string>([layer.id]);
		let current: string | undefined = matteLayer.id;
		while (current) {
			if (visited.has(current)) {
				issues.push({
					layerId: layer.id,
					message: 'Track Matte references contain a cycle.',
				});
				break;
			}
			visited.add(current);
			current = byId.get(current)?.matte?.layerId;
		}
	}

	return issues;
};
