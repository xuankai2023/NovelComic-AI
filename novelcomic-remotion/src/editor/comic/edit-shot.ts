import type {CameraAnimation} from '../motion/types';
import {writeShotCameraPropertySet} from '../property/materialize-motion';
import type {UndoableState} from '../state/types';
import {assertLoopWindow, assertUniqueFrames} from './assert-motion';
import {domainInvariant} from './errors';
import type {Shot, ShotTransition} from './types';
import {applyShotTiming, cloneUndoableState, reflowShots} from './upsert-shot';

export type EditShotInput = {
	shotId: string;
	name?: string;
	durationInFrames?: number;
	cameraMotion?: CameraAnimation | null;
	transitionOut?: ShotTransition | null;
};

const cloneCamera = (camera: CameraAnimation): CameraAnimation => {
	return {
		...camera,
		keyframes: camera.keyframes.map((keyframe) => {
			return {...keyframe};
		}),
	};
};

const assertCamera = (
	camera: CameraAnimation,
	durationInFrames: number,
	shotId: string,
): void => {
	assertLoopWindow(camera, 'Camera', {shotId});
	assertUniqueFrames(
		camera.keyframes.map((keyframe) => keyframe.frame),
		durationInFrames,
		'Camera',
		{shotId},
	);
	for (const keyframe of camera.keyframes) {
		if (
			keyframe.scale !== undefined &&
			(!Number.isFinite(keyframe.scale) || keyframe.scale <= 0)
		) {
			throw domainInvariant('Camera scale must be positive', {shotId});
		}
	}
};

export const editShot = (
	project: UndoableState,
	input: EditShotInput,
): UndoableState => {
	const draft = cloneUndoableState(project);
	const shots = draft.shots ?? [];
	const index = shots.findIndex((shot) => {
		return shot.id === input.shotId;
	});
	if (index === -1) {
		throw domainInvariant(`Shot ${input.shotId} does not exist`, {
			shotId: input.shotId,
		});
	}

	const current = shots[index];
	const durationInFrames = input.durationInFrames ?? current.durationInFrames;
	if (!Number.isInteger(durationInFrames) || durationInFrames < 1) {
		throw domainInvariant('Shot durationInFrames must be a positive integer', {
			shotId: input.shotId,
		});
	}

	let transitionOut: ShotTransition = current.transitionOut ?? {type: 'cut'};
	if (input.transitionOut === null) {
		transitionOut = {type: 'cut'};
	} else if (input.transitionOut) {
		transitionOut = {...input.transitionOut};
	}

	let cameraMotion = current.cameraMotion
		? cloneCamera(current.cameraMotion)
		: undefined;
	if (input.cameraMotion === null) {
		cameraMotion = undefined;
	} else if (input.cameraMotion) {
		cameraMotion = cloneCamera(input.cameraMotion);
	}

	if (cameraMotion) {
		assertCamera(cameraMotion, durationInFrames, input.shotId);
	}

	const next: Shot = {
		...current,
		name: input.name ?? current.name,
		durationInFrames,
		transitionOut,
		layerTrackIds: [...current.layerTrackIds],
		dialogueItemIds: [...current.dialogueItemIds],
	};
	if (cameraMotion) {
		next.cameraMotion = cameraMotion;
	} else {
		delete next.cameraMotion;
	}

	shots[index] = next;
	const previous = new Map(
		(project.shots ?? []).map((shot) => {
			return [shot.id, shot] as const;
		}),
	);
	return writeShotCameraPropertySet(
		applyShotTiming(draft, previous, reflowShots(shots)),
		input.shotId,
		cameraMotion,
	);
};
