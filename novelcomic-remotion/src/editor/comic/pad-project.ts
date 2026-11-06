import type {UndoableState} from '../state/types';
import {editShot} from './edit-shot';
import {domainInvariant} from './errors';
import {batchDurationFrames} from './limits';
import type {Shot} from './types';

const projectEndFrame = (project: UndoableState, last: Shot): number => {
	let itemEnd = 0;
	for (const item of Object.values(project.items)) {
		const end = item.from + item.durationInFrames;
		if (end > itemEnd) {
			itemEnd = end;
		}
	}

	return Math.max(last.from + last.durationInFrames, itemEnd);
};

export const padProjectToMinimumDuration = (
	project: UndoableState,
	minimumDurationInFrames?: number,
): UndoableState => {
	const shots = project.shots ?? [];
	if (shots.length === 0) {
		throw domainInvariant('Cannot pad a project that has no shots');
	}

	const last = shots.reduce((current, shot) => {
		return shot.from + shot.durationInFrames >
			current.from + current.durationInFrames
			? shot
			: current;
	});
	const min = minimumDurationInFrames ?? batchDurationFrames(project.fps).min;
	if (!Number.isInteger(min) || min < 1) {
		throw domainInvariant('minimumDurationInFrames must be a positive integer');
	}
	const end = projectEndFrame(project, last);
	if (end >= min) {
		return project;
	}

	const shotEnd = last.from + last.durationInFrames;
	return editShot(project, {
		shotId: last.id,
		durationInFrames: last.durationInFrames + (min - shotEnd),
	});
};
