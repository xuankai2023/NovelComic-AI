import type {TrackType, UndoableState} from '../state/types';
import type {Shot} from './types';

const isAudioTrack = (
	track: TrackType,
	items: UndoableState['items'],
): boolean => {
	return (
		track.items.length > 0 &&
		track.items.every((itemId) => {
			return items[itemId]?.type === 'audio';
		})
	);
};

const trackStart = (
	track: TrackType,
	items: UndoableState['items'],
): number => {
	let start = Number.POSITIVE_INFINITY;
	for (const itemId of track.items) {
		const item = items[itemId];
		if (item) {
			start = Math.min(start, item.from);
		}
	}

	return start;
};

const sortShotGroup = (
	shot: Shot,
	tracks: readonly TrackType[],
): TrackType[] => {
	const rank = new Map(
		shot.layerTrackIds.map((trackId, index) => {
			return [trackId, index];
		}),
	);

	return [...tracks].sort((left, right) => {
		const leftRank = rank.get(left.id);
		const rightRank = rank.get(right.id);
		const leftKnown = leftRank !== undefined;
		const rightKnown = rightRank !== undefined;
		if (leftKnown && rightKnown && leftRank !== rightRank) {
			return leftRank - rightRank;
		}

		if (leftKnown !== rightKnown) {
			return leftKnown ? -1 : 1;
		}

		return left.id.localeCompare(right.id);
	});
};

export const reorderComicTracks = (project: UndoableState): UndoableState => {
	if (!project.shots || project.shots.length === 0) {
		return project;
	}

	const shotById = new Map(
		project.shots.map((shot) => {
			return [shot.id, shot];
		}),
	);
	const dialogue: TrackType[] = [];
	const globalEffects: TrackType[] = [];
	const audio: TrackType[] = [];
	const other: TrackType[] = [];
	const byShot = new Map<string, TrackType[]>();

	for (const track of project.tracks) {
		if (track.semantic === 'dialogue') {
			dialogue.push(track);
			continue;
		}

		if (isAudioTrack(track, project.items)) {
			audio.push(track);
			continue;
		}

		if (track.semantic === 'effect' && !track.shotId) {
			globalEffects.push(track);
			continue;
		}

		if (track.shotId && shotById.has(track.shotId)) {
			const group = byShot.get(track.shotId) ?? [];
			group.push(track);
			byShot.set(track.shotId, group);
			continue;
		}

		other.push(track);
	}

	dialogue.sort((left, right) => {
		const startDelta =
			trackStart(left, project.items) - trackStart(right, project.items);
		if (startDelta !== 0 && Number.isFinite(startDelta)) {
			return startDelta;
		}

		return left.id.localeCompare(right.id);
	});
	globalEffects.sort((left, right) => {
		return left.id.localeCompare(right.id);
	});

	const orderedShots = [...project.shots].sort((left, right) => {
		if (left.from !== right.from) {
			return left.from - right.from;
		}

		return left.id.localeCompare(right.id);
	});
	const shotTracks: TrackType[] = [];
	for (let index = orderedShots.length - 1; index >= 0; index--) {
		const shot = orderedShots[index];
		shotTracks.push(...sortShotGroup(shot, byShot.get(shot.id) ?? []));
	}

	const nextTracks = [
		...dialogue,
		...globalEffects,
		...shotTracks,
		...audio,
		...other,
	];
	const unchanged =
		nextTracks.length === project.tracks.length &&
		nextTracks.every((track, index) => {
			return track.id === project.tracks[index]?.id;
		});
	if (unchanged) {
		return project;
	}

	return {
		...project,
		tracks: nextTracks,
	};
};
