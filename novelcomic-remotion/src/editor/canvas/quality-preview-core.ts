import type React from 'react';
import {panelIds} from '../comic/append-image-sequence';
import {panelFitIds} from '../comic/panel-fit';
import type {ProjectIssue, Shot} from '../comic/types';
import {validateManualLayerBounds} from '../comic/validate-layer-bounds';
import {validateMotionExposureForProject} from '../comic/validate-motion-exposure';
import type {TrackType, UndoableState} from '../state/types';

export const QUALITY_PREVIEW_MODES = [
	'normal',
	'source',
	'recomposed',
	'overlay',
	'difference',
	'checkerboard',
	'mask',
	'alpha-holes',
] as const;

export type QualityPreviewMode = (typeof QUALITY_PREVIEW_MODES)[number];

export type QualityPreviewVisibility = {
	source: boolean;
	cleanPlate: boolean;
	cutouts: boolean;
};

export const DEFAULT_QUALITY_PREVIEW_VISIBILITY: QualityPreviewVisibility = {
	source: true,
	cleanPlate: true,
	cutouts: true,
};

const panelTrackIds = (shotId: string): Set<string> => {
	const legacy = panelIds(shotId);
	const fit = panelFitIds(shotId);
	return new Set([
		legacy.trackId,
		fit.foregroundTrackId,
		fit.backgroundTrackId,
	]);
};

export const isSourcePanelTrack = (
	track: TrackType,
	shots: readonly Shot[],
): boolean => {
	if (track.role === 'source') {
		return true;
	}

	if (!track.shotId) {
		return false;
	}

	if (!shots.some((shot) => shot.id === track.shotId)) {
		return false;
	}

	return panelTrackIds(track.shotId).has(track.id);
};

export const isComicEnhancementTrack = (
	track: TrackType,
	shots: readonly Shot[],
): boolean => {
	return Boolean(
		track.shotId &&
		shots.some((shot) => shot.id === track.shotId) &&
		!isSourcePanelTrack(track, shots) &&
		track.semantic !== 'dialogue',
	);
};

export const isCleanPlateTrack = (track: TrackType): boolean => {
	return (
		track.role === 'clean-plate' ||
		track.id.endsWith(':clean-plate') ||
		track.items.some((itemId) => itemId.endsWith(':clean-plate'))
	);
};

export const isCutoutTrack = (
	track: TrackType,
	shots: readonly Shot[],
): boolean => {
	return (
		track.role === 'cutout' ||
		(isComicEnhancementTrack(track, shots) && !isCleanPlateTrack(track))
	);
};

export type QualityTrackPlan = {
	baseTracks: TrackType[];
	overlayTracks: TrackType[];
	overlayBlendMode?: React.CSSProperties['mixBlendMode'];
	overlayOpacity?: number;
	checkerboard?: boolean;
	warnings: string[];
	finalCompositionReady: boolean;
	usesSourceFallback: boolean;
};

export const getQualityTrackPlan = (
	tracks: readonly TrackType[],
	shots: readonly Shot[],
	mode: QualityPreviewMode,
	visibility: QualityPreviewVisibility = DEFAULT_QUALITY_PREVIEW_VISIBILITY,
): QualityTrackPlan => {
	const sourceTracks = tracks.filter((track) => {
		return isSourcePanelTrack(track, shots);
	});
	const enhancementShotIds = new Set(
		tracks
			.filter((track) => isComicEnhancementTrack(track, shots))
			.map((track) => track.shotId)
			.filter((shotId): shotId is string => Boolean(shotId)),
	);
	const shotIdsWithCutouts = new Set(
		tracks
			.filter((track) => isCutoutTrack(track, shots))
			.map((track) => track.shotId)
			.filter((shotId): shotId is string => Boolean(shotId)),
	);
	const shotIdsWithCleanPlates = new Set(
		tracks
			.filter(isCleanPlateTrack)
			.map((track) => track.shotId)
			.filter((shotId): shotId is string => Boolean(shotId)),
	);
	const incompleteShotIds = [...shotIdsWithCutouts].filter(
		(shotId) => !shotIdsWithCleanPlates.has(shotId),
	);
	const completedShotIds = new Set(
		[...shotIdsWithCutouts].filter((shotId) =>
			shotIdsWithCleanPlates.has(shotId),
		),
	);
	const warnings = incompleteShotIds.map(
		(shotId) => `Clean Plate is missing for shot ${shotId}`,
	);
	const finalCompositionReady = incompleteShotIds.length === 0;
	const canShowTrack = (track: TrackType): boolean => {
		if (track.hidden) {
			return false;
		}

		if (isSourcePanelTrack(track, shots)) {
			if (track.shotId && completedShotIds.has(track.shotId)) {
				return false;
			}
			return visibility.source;
		}

		if (isCleanPlateTrack(track)) {
			return visibility.cleanPlate;
		}

		if (isCutoutTrack(track, shots)) {
			return visibility.cutouts;
		}

		return true;
	};
	const visibleTracks = tracks.filter(canShowTrack);
	const recomposedTracks = visibleTracks.filter((track) => {
		if (
			track.shotId &&
			enhancementShotIds.has(track.shotId) &&
			isSourcePanelTrack(track, shots)
		) {
			return !visibility.cutouts;
		}

		return true;
	});
	const normalTracks = finalCompositionReady ? recomposedTracks : visibleTracks;
	const usesSourceFallback =
		!finalCompositionReady &&
		normalTracks.some((track) => isSourcePanelTrack(track, shots));

	if (mode === 'source') {
		return {
			baseTracks: visibility.source
				? sourceTracks.map((track) => ({...track, hidden: false}))
				: [],
			overlayTracks: [],
			warnings,
			finalCompositionReady,
			usesSourceFallback: false,
		};
	}

	if (mode === 'mask') {
		return {
			baseTracks: [],
			overlayTracks: [],
			warnings,
			finalCompositionReady,
			usesSourceFallback: false,
		};
	}

	if (mode === 'overlay') {
		return {
			baseTracks: normalTracks,
			overlayTracks: visibility.source
				? sourceTracks.map((track) => ({...track, hidden: false}))
				: [],
			overlayBlendMode: 'normal',
			overlayOpacity: 0.5,
			warnings,
			finalCompositionReady,
			usesSourceFallback,
		};
	}

	if (mode === 'difference') {
		return {
			baseTracks: normalTracks,
			overlayTracks: visibility.source
				? sourceTracks.map((track) => ({...track, hidden: false}))
				: [],
			overlayBlendMode: 'difference',
			overlayOpacity: 0.8,
			warnings,
			finalCompositionReady,
			usesSourceFallback,
		};
	}

	return {
		baseTracks: mode === 'normal' ? normalTracks : recomposedTracks,
		overlayTracks: [],
		checkerboard: mode === 'checkerboard',
		warnings,
		finalCompositionReady,
		usesSourceFallback:
			mode === 'normal' || mode === 'checkerboard' ? usesSourceFallback : false,
	};
};

export const diagnosticValue = (shot: Shot, prefix: string): number | null => {
	const entry = shot.diagnostics?.find((value) => value.startsWith(prefix));
	if (!entry) {
		return null;
	}

	const value = Number(entry.slice(prefix.length));
	return Number.isFinite(value) ? value : null;
};

export type QualityIssueSummary = {
	issues: ProjectIssue[];
	shotIdsWithAlphaHoles: string[];
};

export const summarizeQualityIssues = (
	project: UndoableState,
): QualityIssueSummary => {
	const issues: ProjectIssue[] = [];
	const shotIdsWithAlphaHoles: string[] = [];
	const shots = project.shots ?? [];

	for (const shot of shots) {
		const alphaHoleRatio = diagnosticValue(shot, 'alphaHoleRatio:');
		if (alphaHoleRatio !== null && alphaHoleRatio > 0.005) {
			shotIdsWithAlphaHoles.push(shot.id);
			issues.push({
				severity: alphaHoleRatio > 0.03 ? 'error' : 'warning',
				code: 'ALPHA_HOLE_RISK',
				message: `Shot ${shot.id} has alpha hole ratio ${alphaHoleRatio}`,
				shotId: shot.id,
			});
		}

		const recompositionScore = diagnosticValue(shot, 'recompositionScore:');
		if (recompositionScore !== null && recompositionScore > 0.08) {
			issues.push({
				severity: recompositionScore > 0.2 ? 'error' : 'warning',
				code: 'RECOMPOSITION_DRIFT',
				message: `Shot ${shot.id} has recomposition score ${recompositionScore}`,
				shotId: shot.id,
			});
		}

		const edgeArtifactScore = diagnosticValue(shot, 'edgeArtifactScore:');
		if (edgeArtifactScore !== null && edgeArtifactScore > 0.08) {
			issues.push({
				severity: edgeArtifactScore > 0.2 ? 'error' : 'warning',
				code: 'EDGE_ARTIFACT_RISK',
				message: `Shot ${shot.id} has edge artifact score ${edgeArtifactScore}`,
				shotId: shot.id,
			});
		}
	}

	issues.push(...validateManualLayerBounds(project));
	issues.push(...validateMotionExposureForProject(project));

	return {
		issues,
		shotIdsWithAlphaHoles,
	};
};
