import {deleteShot} from '../comic/delete-shot';
import {editShot} from '../comic/edit-shot';
import type {ShotTransition} from '../comic/types';
import {upsertShot} from '../comic/upsert-shot';
import type {UndoableState} from '../state/types';
import {generateRandomId} from '../utils/generate-random-id';

export type CreateShotInput = {
	project: UndoableState;
	fps: number;
	currentFrame: number;
	createId?: () => string;
};

export type UpdateShotInput = {
	project: UndoableState;
	shotId: string;
	name: string;
	durationInFrames: number;
	startFrame?: number;
	transitionOut: ShotTransition;
};

const defaultShotDuration = (fps: number): number => {
	if (!Number.isFinite(fps) || fps <= 0) {
		return 150;
	}

	return Math.max(1, Math.round(fps * 5));
};

export const createShotFromPanel = ({
	project,
	fps,
	currentFrame,
	createId = () => `shot:${generateRandomId(8)}`,
}: CreateShotInput): UndoableState => {
	const shots = project.shots ?? [];
	const shotNumber = shots.length + 1;
	return upsertShot(project, {
		shotId: createId(),
		name: `Shot ${shotNumber}`,
		from: shots.length === 0 ? Math.max(0, Math.round(currentFrame)) : undefined,
		durationInFrames: defaultShotDuration(fps),
		transitionOut: {type: 'cut'},
	});
};

export const updateShotFromPanel = ({
	project,
	shotId,
	name,
	durationInFrames,
	startFrame,
	transitionOut,
}: UpdateShotInput): UndoableState => {
	const shots = project.shots ?? [];
	const current = shots.find((shot) => shot.id === shotId);
	if (!current) {
		return project;
	}

	let next = project;
	if (startFrame !== undefined && startFrame !== current.from) {
		next = upsertShot(project, {
			shotId,
			name: current.name,
			from: startFrame,
			durationInFrames: current.durationInFrames,
			transitionOut: current.transitionOut,
		});
	}

	return editShot(next, {
		shotId,
		name,
		durationInFrames,
		transitionOut,
	});
};

export const deleteShotFromPanel = (
	project: UndoableState,
	shotId: string,
): UndoableState => {
	return deleteShot(project, shotId);
};

