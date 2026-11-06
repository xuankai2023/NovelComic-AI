import {describe, expect, it} from 'vitest';
import type {Shot} from '../comic/types';
import type {TrackType, UndoableState} from '../state/types';
import {
	getQualityTrackPlan,
	summarizeQualityIssues,
} from './quality-preview-core';

const shot = (diagnostics: string[] = []): Shot => {
	return {
		id: 'shot-1',
		name: 'Shot 1',
		from: 0,
		durationInFrames: 60,
		layerTrackIds: ['track:shot-1:background', 'track:shot-1:panel'],
		dialogueItemIds: [],
		diagnostics,
	};
};

const track = (
	id: string,
	semantic?: TrackType['semantic'],
	hidden = false,
): TrackType => {
	return {
		id,
		items: [`item:${id}`],
		hidden,
		muted: false,
		shotId: 'shot-1',
		semantic,
	};
};

describe('quality preview', () => {
	it('builds source, recomposed, and difference track plans', () => {
		const shots = [shot()];
		const tracks = [
			track('track:shot-1:panel', 'background', true),
			track('track:shot-1:background', 'background'),
			track('track:shot-1:hair', 'hair'),
			track('track:shot-1:dialogue', 'dialogue'),
		];

		expect(
			getQualityTrackPlan(tracks, shots, 'source').baseTracks.map((entry) => {
				return entry.id;
			}),
		).toEqual(['track:shot-1:panel']);
		expect(
			getQualityTrackPlan(tracks, shots, 'source').baseTracks[0]?.hidden,
		).toBe(false);

		expect(
			getQualityTrackPlan(tracks, shots, 'recomposed').baseTracks.map(
				(entry) => {
					return entry.id;
				},
			),
		).toEqual([
			'track:shot-1:background',
			'track:shot-1:hair',
			'track:shot-1:dialogue',
		]);

		const difference = getQualityTrackPlan(tracks, shots, 'difference');
		expect(difference.baseTracks.map((entry) => entry.id)).toEqual([
			'track:shot-1:background',
			'track:shot-1:hair',
			'track:shot-1:dialogue',
		]);
		expect(difference.overlayTracks.map((entry) => entry.id)).toEqual([
			'track:shot-1:panel',
		]);
		expect(difference.overlayBlendMode).toBe('difference');
	});

	it('supports overlay and checkerboard previews with layer visibility switches', () => {
		const shots = [shot()];
		const tracks = [
			track('track:shot-1:panel', 'background'),
			track('track:shot-1:clean-plate', 'background'),
			track('track:shot-1:hair', 'hair'),
		];

		const overlay = getQualityTrackPlan(tracks, shots, 'overlay');
		expect(overlay.baseTracks.map((entry) => entry.id)).toEqual([
			'track:shot-1:clean-plate',
			'track:shot-1:hair',
		]);
		expect(overlay.overlayTracks.map((entry) => entry.id)).toEqual([
			'track:shot-1:panel',
		]);
		expect(overlay.overlayOpacity).toBe(0.5);

		const checkerboard = getQualityTrackPlan(tracks, shots, 'checkerboard', {
			source: false,
			cleanPlate: true,
			cutouts: false,
		});
		expect(checkerboard.checkerboard).toBe(true);
		expect(checkerboard.baseTracks.map((entry) => entry.id)).toEqual([
			'track:shot-1:clean-plate',
		]);

		expect(getQualityTrackPlan(tracks, shots, 'mask').baseTracks).toEqual([]);
	});

	it('keeps incomplete Normal as an explicit source fallback', () => {
		const shots = [shot()];
		const tracks = [
			track('track:shot-1:panel', 'background'),
			{
				...track('track:shot-1:hair', 'hair'),
				role: 'cutout' as const,
			},
		];

		const normal = getQualityTrackPlan(tracks, shots, 'normal');
		expect(normal.finalCompositionReady).toBe(false);
		expect(normal.usesSourceFallback).toBe(true);
		expect(normal.warnings).toEqual(['Clean Plate is missing for shot shot-1']);
		expect(normal.baseTracks.map((entry) => entry.id)).toEqual([
			'track:shot-1:panel',
			'track:shot-1:hair',
		]);

		const layers = getQualityTrackPlan(tracks, shots, 'recomposed');
		expect(layers.baseTracks.map((entry) => entry.id)).toEqual([
			'track:shot-1:hair',
		]);
		expect(layers.baseTracks.some((entry) => entry.role === 'source')).toBe(
			false,
		);
	});

	it('uses the same Normal plan for overlay and difference', () => {
		const shots = [shot()];
		const tracks = [
			{
				...track('track:shot-1:panel', 'background'),
				role: 'source' as const,
			},
			{
				...track('track:shot-1:clean-plate', 'background'),
				role: 'clean-plate' as const,
			},
			{
				...track('track:shot-1:hair', 'hair'),
				role: 'cutout' as const,
			},
		];

		const normalIds = getQualityTrackPlan(
			tracks,
			shots,
			'normal',
		).baseTracks.map((entry) => entry.id);
		expect(
			getQualityTrackPlan(tracks, shots, 'overlay').baseTracks.map(
				(entry) => entry.id,
			),
		).toEqual(normalIds);
		expect(
			getQualityTrackPlan(tracks, shots, 'difference').baseTracks.map(
				(entry) => entry.id,
			),
		).toEqual(normalIds);
	});

	it('uses explicit comic roles for manual source and clean plate tracks', () => {
		const shots = [shot()];
		const tracks: TrackType[] = [
			{
				...track('manual-source', 'background'),
				role: 'source',
				hidden: true,
			},
			{
				...track('manual-clean', 'background'),
				role: 'clean-plate',
			},
			{
				...track('manual-cutout', 'hair'),
				role: 'cutout',
			},
		];

		const normal = getQualityTrackPlan(tracks, shots, 'normal');
		expect(normal.baseTracks.map((entry) => entry.id)).toEqual([
			'manual-clean',
			'manual-cutout',
		]);
		expect(normal.finalCompositionReady).toBe(true);
		expect(normal.warnings).toEqual([]);

		const source = getQualityTrackPlan(tracks, shots, 'source');
		expect(source.baseTracks.map((entry) => entry.id)).toEqual([
			'manual-source',
		]);
	});

	it('warns when a cutout has no clean plate and keeps source as an edit preview', () => {
		const shots = [shot()];
		const tracks: TrackType[] = [
			{
				...track('manual-source', 'background'),
				role: 'source',
			},
			{
				...track('manual-cutout', 'hair'),
				role: 'cutout',
			},
		];

		const normal = getQualityTrackPlan(tracks, shots, 'normal');
		expect(normal.baseTracks.map((entry) => entry.id)).toEqual([
			'manual-source',
			'manual-cutout',
		]);
		expect(normal.finalCompositionReady).toBe(false);
		expect(normal.warnings).toEqual(['Clean Plate is missing for shot shot-1']);
	});

	it('summarizes alpha hole, recomposition, and edge diagnostics', () => {
		const project = {
			tracks: [],
			items: {},
			assets: {},
			deletedAssets: [],
			fps: 30,
			compositionWidth: 1080,
			compositionHeight: 1920,
			shots: [
				shot([
					'alphaHoleRatio:0.04',
					'recompositionScore:0.12',
					'edgeArtifactScore:0.24',
				]),
			],
		} satisfies UndoableState;

		const summary = summarizeQualityIssues(project);
		expect(summary.shotIdsWithAlphaHoles).toEqual(['shot-1']);
		expect(summary.issues.map((issue) => issue.code)).toEqual([
			'ALPHA_HOLE_RISK',
			'RECOMPOSITION_DRIFT',
			'EDGE_ARTIFACT_RISK',
		]);
		expect(summary.issues.map((issue) => issue.severity)).toEqual([
			'error',
			'warning',
			'error',
		]);
	});
});
