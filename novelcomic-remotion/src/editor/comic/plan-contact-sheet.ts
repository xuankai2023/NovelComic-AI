import type {UndoableState} from '../state/types';
import {domainInvariant} from './errors';
import type {Shot} from './types';

export type ContactSheetEntry = {
	shotId: string;
	frame: number;
};

const assertShotRange = (shot: Shot): void => {
	if (
		!Number.isInteger(shot.from) ||
		shot.from < 0 ||
		!Number.isInteger(shot.durationInFrames) ||
		shot.durationInFrames < 1
	) {
		throw domainInvariant(`Shot ${shot.id} has an invalid frame range`, {
			shotId: shot.id,
		});
	}
};

const crossfadeFrames = (shot: Shot | undefined): number => {
	if (shot?.transitionOut?.type !== 'crossfade') {
		return 0;
	}

	const duration = shot.transitionOut.durationInFrames;
	if (!Number.isInteger(duration) || duration < 1) {
		throw domainInvariant(`Shot ${shot.id} has an invalid crossfade`, {
			shotId: shot.id,
		});
	}

	return duration;
};

const midpointFrame = (start: number, endExclusive: number): number => {
	const length = endExclusive - start;
	return start + Math.floor((length - 1) / 2);
};

const stableFrame = (shot: Shot, previous: Shot | undefined): number => {
	const shotStart = shot.from;
	const shotEnd = shot.from + shot.durationInFrames;
	let stableStart = shotStart;
	let stableEnd = shotEnd;

	const incoming = crossfadeFrames(previous);
	if (previous && incoming > 0) {
		const overlapEnd = previous.from + previous.durationInFrames;
		const overlapStart = overlapEnd - incoming;
		if (overlapStart < shotEnd && overlapEnd > shotStart) {
			stableStart = Math.max(stableStart, overlapEnd);
		}
	}

	const outgoing = crossfadeFrames(shot);
	if (outgoing > 0) {
		stableEnd = Math.min(stableEnd, shotEnd - outgoing);
	}

	if (stableEnd > stableStart) {
		return midpointFrame(stableStart, stableEnd);
	}

	return midpointFrame(shotStart, shotEnd);
};

export const planContactSheet = (
	project: UndoableState,
): ContactSheetEntry[] => {
	const shots = [...(project.shots ?? [])].sort((left, right) => {
		return left.from - right.from || left.id.localeCompare(right.id);
	});

	return shots.map((shot, index) => {
		assertShotRange(shot);
		return {
			shotId: shot.id,
			frame: stableFrame(shot, index === 0 ? undefined : shots[index - 1]),
		};
	});
};
