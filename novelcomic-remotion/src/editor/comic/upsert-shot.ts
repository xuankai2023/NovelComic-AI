import type {EditorStarterItem} from '../items/item-type';
import type {CameraAnimation} from '../motion/types';
import {writeShotCameraPropertySet} from '../property/materialize-motion';
import type {UndoableState} from '../state/types';
import {COMIC_ERROR_CODES, ComicEditorError, domainInvariant} from './errors';
import {COMIC_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, MAX_SHOTS} from './limits';
import {cloneComicEditLayers} from './manual-layer-types';
import type {Shot, ShotTransition} from './types';
import {cloneVoiceProfiles} from './voice-profiles';

export type UpsertShotInput = {
	shotId: string;
	name?: string;
	from?: number;
	durationInFrames: number;
	transitionOut?: ShotTransition;
	cameraMotion?: CameraAnimation;
};

const cloneShot = (shot: Shot): Shot => {
	return {
		...shot,
		layerTrackIds: [...shot.layerTrackIds],
		dialogueItemIds: [...shot.dialogueItemIds],
		transitionOut: shot.transitionOut ? {...shot.transitionOut} : undefined,
		cameraMotion: shot.cameraMotion
			? {
					...shot.cameraMotion,
					keyframes: shot.cameraMotion.keyframes.map((keyframe) => {
						return {...keyframe};
					}),
				}
			: undefined,
		diagnostics: shot.diagnostics ? [...shot.diagnostics] : undefined,
	};
};

export const cloneUndoableState = (project: UndoableState): UndoableState => {
	return {
		...project,
		tracks: project.tracks.map((track) => {
			return {
				...track,
				items: [...track.items],
			};
		}),
		items: {...project.items},
		assets: {...project.assets},
		deletedAssets: project.deletedAssets.map((asset) => {
			return {...asset};
		}),
		shots: (project.shots ?? []).map((shot) => {
			return cloneShot(shot);
		}),
		comicEditLayers: cloneComicEditLayers(project.comicEditLayers),
		voiceProfiles: cloneVoiceProfiles(project.voiceProfiles),
		layerGroups: project.layerGroups
			? Object.fromEntries(
					Object.entries(project.layerGroups).map(([id, group]) => [
						id,
						{...group, trackIds: [...group.trackIds]},
					]),
				)
			: project.layerGroups,
		adjustmentLayers: project.adjustmentLayers
			? Object.fromEntries(
					Object.entries(project.adjustmentLayers).map(([id, layer]) => [
						id,
						{
							...layer,
							targetTrackIds: [...layer.targetTrackIds],
							effects: {...layer.effects},
						},
					]),
				)
			: project.adjustmentLayers,
		penPaths: project.penPaths
			? Object.fromEntries(
					Object.entries(project.penPaths).map(([id, path]) => [
						id,
						{
							...path,
							anchors: path.anchors.map((anchor) => ({
								...anchor,
								inHandle: anchor.inHandle ? {...anchor.inHandle} : undefined,
								outHandle: anchor.outHandle ? {...anchor.outHandle} : undefined,
							})),
							bounds: path.bounds ? {...path.bounds} : undefined,
						},
					]),
				)
			: project.penPaths,
	};
};

const crossfadeDuration = (shot: Shot): number | null => {
	if (shot.transitionOut?.type !== 'crossfade') {
		return null;
	}

	return shot.transitionOut.durationInFrames;
};

const assertCrossfade = (shot: Shot, next: Shot | undefined) => {
	const duration = crossfadeDuration(shot);
	if (duration === null) {
		return;
	}

	if (
		!Number.isInteger(duration) ||
		duration < 1 ||
		duration >= shot.durationInFrames
	) {
		throw domainInvariant(
			`Crossfade on shot ${shot.id} must be at least 1 frame and shorter than the shot`,
			{shotId: shot.id},
		);
	}

	if (next && duration >= next.durationInFrames) {
		throw domainInvariant(
			`Crossfade on shot ${shot.id} must be shorter than the next shot`,
			{shotId: shot.id},
		);
	}
};

export const reflowShots = (shots: readonly Shot[]): Shot[] => {
	let cursor = 0;
	return shots.map((shot, index) => {
		const from = index === 0 ? shot.from : cursor;
		const next = shots[index + 1];
		const placed = {
			...shot,
			from,
			layerTrackIds: [...shot.layerTrackIds],
			dialogueItemIds: [...shot.dialogueItemIds],
		};
		assertCrossfade(placed, next);
		const overlap = next ? (crossfadeDuration(placed) ?? 0) : 0;
		cursor = from + placed.durationInFrames - overlap;
		return placed;
	});
};

const collectLayerItemIds = (project: UndoableState, shot: Shot): string[] => {
	const dialogueIds = new Set(shot.dialogueItemIds);
	const ids: string[] = [];
	const seen = new Set<string>();
	const push = (itemId: string) => {
		if (
			dialogueIds.has(itemId) ||
			seen.has(itemId) ||
			project.items[itemId]?.type === 'audio'
		) {
			return;
		}

		seen.add(itemId);
		ids.push(itemId);
	};

	for (const trackId of shot.layerTrackIds) {
		const track = project.tracks.find((entry) => {
			return entry.id === trackId;
		});
		if (!track) {
			continue;
		}

		for (const itemId of track.items) {
			push(itemId);
		}
	}

	for (const item of Object.values(project.items)) {
		if (item.type === 'image' && item.shotId === shot.id) {
			push(item.id);
		}
	}

	return ids;
};

const collectOwnedAudioIds = (project: UndoableState, shot: Shot): string[] => {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const track of project.tracks) {
		if (track.shotId !== shot.id) {
			continue;
		}

		for (const itemId of track.items) {
			if (seen.has(itemId) || project.items[itemId]?.type !== 'audio') {
				continue;
			}

			seen.add(itemId);
			ids.push(itemId);
		}
	}

	return ids;
};

export const applyShotTiming = (
	project: UndoableState,
	previous: ReadonlyMap<string, Shot>,
	shots: readonly Shot[],
): UndoableState => {
	let items: Record<string, EditorStarterItem> = project.items;
	for (const shot of shots) {
		const prev = previous.get(shot.id);
		const delta = prev ? shot.from - prev.from : 0;
		for (const itemId of collectLayerItemIds(project, shot)) {
			const item = items[itemId];
			if (!item) {
				continue;
			}

			if (
				item.from === shot.from &&
				item.durationInFrames === shot.durationInFrames
			) {
				continue;
			}

			items = {
				...items,
				[itemId]: {
					...item,
					from: shot.from,
					durationInFrames: shot.durationInFrames,
				},
			};
		}

		const shotEnd = shot.from + shot.durationInFrames;
		for (const itemId of shot.dialogueItemIds) {
			const item = items[itemId];
			if (!item) {
				continue;
			}

			const from = item.from + delta;
			const end = from + item.durationInFrames;
			if (from < shot.from || end > shotEnd) {
				throw domainInvariant(
					`Dialogue ${itemId} falls outside shot ${shot.id}`,
					{shotId: shot.id, itemId},
				);
			}

			if (from !== item.from) {
				items = {
					...items,
					[itemId]: {
						...item,
						from,
					},
				};
			}
		}

		for (const itemId of collectOwnedAudioIds(project, shot)) {
			const item = items[itemId];
			if (!item) {
				continue;
			}

			const from = item.from + delta;
			const end = from + item.durationInFrames;
			if (from < shot.from || end > shotEnd) {
				throw domainInvariant(`Audio ${itemId} falls outside shot ${shot.id}`, {
					shotId: shot.id,
					itemId,
				});
			}

			if (from !== item.from) {
				items = {
					...items,
					[itemId]: {
						...item,
						from,
					},
				};
			}
		}
	}

	return {
		...project,
		items,
		shots: [...shots],
	};
};

export const upsertShot = (
	project: UndoableState,
	input: UpsertShotInput,
): UndoableState => {
	if (!Number.isInteger(input.durationInFrames) || input.durationInFrames < 1) {
		throw domainInvariant('Shot durationInFrames must be a positive integer', {
			shotId: input.shotId,
		});
	}

	if (
		input.from !== undefined &&
		(!Number.isInteger(input.from) || input.from < 0)
	) {
		throw domainInvariant('Shot from must be a non-negative integer', {
			shotId: input.shotId,
		});
	}

	const draft = cloneUndoableState(project);
	draft.schemaVersion = Math.max(
		draft.schemaVersion ?? LEGACY_SCHEMA_VERSION,
		COMIC_SCHEMA_VERSION,
	);
	const shots = draft.shots ?? [];
	const previous = new Map(
		(project.shots ?? []).map((shot) => [shot.id, shot]),
	);
	const index = shots.findIndex((shot) => {
		return shot.id === input.shotId;
	});

	if (index === -1) {
		if (shots.length >= MAX_SHOTS) {
			throw new ComicEditorError({
				code: COMIC_ERROR_CODES.PAYLOAD_TOO_LARGE,
				message: `Shot count cannot exceed ${MAX_SHOTS}`,
				retryable: false,
				status: 413,
				shotId: input.shotId,
			});
		}

		const from =
			shots.length === 0
				? (input.from ?? 0)
				: shots[shots.length - 1].from +
					shots[shots.length - 1].durationInFrames;
		const created: Shot = {
			id: input.shotId,
			name: input.name ?? input.shotId,
			from,
			durationInFrames: input.durationInFrames,
			layerTrackIds: [],
			dialogueItemIds: [],
			transitionOut: input.transitionOut ?? {type: 'cut'},
		};
		if (input.cameraMotion) {
			created.cameraMotion = input.cameraMotion;
		}

		shots.push(created);
	} else {
		const current = shots[index];
		shots[index] = {
			...current,
			name: input.name ?? current.name,
			durationInFrames: input.durationInFrames,
			from: input.from ?? current.from,
			transitionOut: input.transitionOut ??
				current.transitionOut ?? {type: 'cut'},
			cameraMotion:
				input.cameraMotion !== undefined
					? input.cameraMotion
					: current.cameraMotion,
		};
	}

	const updated = applyShotTiming(draft, previous, reflowShots(shots));
	return writeShotCameraPropertySet(
		updated,
		input.shotId,
		updated.shots?.find((shot) => shot.id === input.shotId)?.cameraMotion,
	);
};
