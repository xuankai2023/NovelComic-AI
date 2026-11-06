import type {ImageItem} from '../items/image/image-item-type';
import {evaluateImagePose} from '../motion/evaluate';
import type {TrackType, UndoableState} from '../state/types';
import type {ProjectIssue, Shot} from './types';

type Rect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

type ShotLayer = {
	item: ImageItem;
	track: TrackType;
};

const allShotLayers = (project: UndoableState, shot: Shot): ShotLayer[] => {
	const layers: ShotLayer[] = [];
	for (const trackId of shot.layerTrackIds) {
		const track = project.tracks.find((entry) => entry.id === trackId);
		if (!track) {
			continue;
		}

		for (const itemId of track.items) {
			const item = project.items[itemId];
			if (item?.type === 'image') {
				layers.push({item, track});
			}
		}
	}

	return layers;
};

const EXPOSURE_EPSILON = 0.5;
const MAX_EXPOSURE_SAMPLES = 1800;

type Point = {
	x: number;
	y: number;
};

const poseCorners = (pose: {
	left: number;
	top: number;
	width: number;
	height: number;
	rotation: number;
	anchorX: number;
	anchorY: number;
}): Point[] => {
	const anchorLeft = pose.width * pose.anchorX;
	const anchorTop = pose.height * pose.anchorY;
	const corners = [
		[-anchorLeft, -anchorTop],
		[pose.width - anchorLeft, -anchorTop],
		[pose.width - anchorLeft, pose.height - anchorTop],
		[-anchorLeft, pose.height - anchorTop],
	];
	const radians = (pose.rotation * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return corners.map(([x, y]) => {
		return {
			x: pose.left + pose.width * pose.anchorX + x * cos - y * sin,
			y: pose.top + pose.height * pose.anchorY + x * sin + y * cos,
		};
	});
};

const canvasCorners = (canvas: Rect): Point[] => {
	return [
		{x: canvas.left, y: canvas.top},
		{x: canvas.left + canvas.width, y: canvas.top},
		{x: canvas.left + canvas.width, y: canvas.top + canvas.height},
		{x: canvas.left, y: canvas.top + canvas.height},
	];
};

const pointInsideConvexPolygon = (
	point: Point,
	polygon: readonly Point[],
): boolean => {
	let sign = 0;
	for (let index = 0; index < polygon.length; index++) {
		const current = polygon[index];
		const next = polygon[(index + 1) % polygon.length];
		if (!current || !next) {
			continue;
		}

		const cross =
			(next.x - current.x) * (point.y - current.y) -
			(next.y - current.y) * (point.x - current.x);
		if (Math.abs(cross) <= EXPOSURE_EPSILON) {
			continue;
		}

		const currentSign = Math.sign(cross);
		if (sign === 0) {
			sign = currentSign;
		} else if (sign !== currentSign) {
			return false;
		}
	}

	return true;
};

const poseCoversCanvas = (
	pose: {
		left: number;
		top: number;
		width: number;
		height: number;
		rotation: number;
		anchorX: number;
		anchorY: number;
	},
	canvas: Rect,
): boolean => {
	const polygon = poseCorners(pose);
	return canvasCorners(canvas).every((corner) => {
		return pointInsideConvexPolygon(corner, polygon);
	});
};

const sampleFrames = (shot: Shot, layers: readonly ShotLayer[]): number[] => {
	const frames = new Set<number>([0, shot.durationInFrames - 1]);
	const step = Math.max(
		1,
		Math.ceil(shot.durationInFrames / MAX_EXPOSURE_SAMPLES),
	);

	for (let frame = 0; frame < shot.durationInFrames; frame += step) {
		frames.add(frame);
	}

	for (const {item} of layers) {
		for (const keyframe of item.motion?.transform?.keyframes ?? []) {
			if (
				Number.isInteger(keyframe.frame) &&
				keyframe.frame >= 0 &&
				keyframe.frame < shot.durationInFrames
			) {
				frames.add(keyframe.frame);
			}
		}
	}

	for (const keyframe of shot.cameraMotion?.keyframes ?? []) {
		if (
			Number.isInteger(keyframe.frame) &&
			keyframe.frame >= 0 &&
			keyframe.frame < shot.durationInFrames
		) {
			frames.add(keyframe.frame);
		}
	}

	return [...frames].sort((left, right) => left - right);
};

const shotLayers = (project: UndoableState, shot: Shot): ShotLayer[] => {
	const layers: ShotLayer[] = [];
	for (const trackId of shot.layerTrackIds) {
		const track = project.tracks.find((entry) => entry.id === trackId);
		if (!track || track.hidden) {
			continue;
		}

		for (const itemId of track.items) {
			const item = project.items[itemId];
			if (item?.type === 'image') {
				layers.push({item, track});
			}
		}
	}

	return layers;
};

const exposureIssue = (
	shot: Shot,
	plate: ImageItem,
	frame: number,
): ProjectIssue => {
	return {
		severity: 'error',
		code: 'MOTION_EXPOSES_TRANSPARENT_AREA',
		message: `Clean plate for shot ${shot.id} does not cover the composition after motion at frame ${frame}`,
		shotId: shot.id,
		itemId: plate.id,
		frame: shot.from + frame,
	};
};

const sourceAnimationIssue = (
	shot: Shot,
	item: ImageItem,
): ProjectIssue => {
	return {
		severity: 'error',
		code: 'SOURCE_LAYER_ANIMATED',
		message: `L0 source item ${item.id} cannot receive final animation`,
		shotId: shot.id,
		itemId: item.id,
	};
};

const initialAlignmentIssue = (
	shot: Shot,
	item: ImageItem,
): ProjectIssue => {
	return {
		severity: 'error',
		code: 'MOTION_INITIAL_ALIGNMENT',
		message: `Item ${item.id} does not start at its original position`,
		shotId: shot.id,
		itemId: item.id,
		frame: shot.from,
	};
};

const startsAtIdentity = (item: ImageItem): boolean => {
	const keyframes = item.motion?.transform?.keyframes ?? [];
	if (keyframes.length === 0) {
		return true;
	}

	const first = [...keyframes].sort((left, right) => left.frame - right.frame)[0];
	if (!first) {
		return true;
	}

	const value = (
		key: 'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity',
		defaultValue: number,
	) => first[key] ?? defaultValue;

	return (
		Math.abs(value('x', 0)) <= EXPOSURE_EPSILON &&
		Math.abs(value('y', 0)) <= EXPOSURE_EPSILON &&
		Math.abs(value('scaleX', 1) - 1) <= EXPOSURE_EPSILON &&
		Math.abs(value('scaleY', 1) - 1) <= EXPOSURE_EPSILON &&
		Math.abs(value('rotation', 0)) <= EXPOSURE_EPSILON &&
		Math.abs(value('opacity', 1) - 1) <= EXPOSURE_EPSILON
	);
};

/**
 * Checks the only coverage source that can guarantee a transparent region is
 * filled after motion: the imported clean plate. When no clean plate exists,
 * L0 remains visible by contract, so this check intentionally does not fail
 * the project or pretend to know the source image's pixel alpha.
 */
export const validateMotionExposure = (
	project: UndoableState,
	shot: Shot,
): ProjectIssue[] => {
	const allLayers = allShotLayers(project, shot);
	const issues: ProjectIssue[] = [];
	for (const {item, track} of allLayers) {
		if (track.role === 'source' && item.motion) {
			issues.push(sourceAnimationIssue(shot, item));
		}
	}

	for (const {item, track} of allLayers) {
		if (track.role === 'source' || !item.motion?.transform) {
			continue;
		}

		if (!startsAtIdentity(item)) {
			issues.push(initialAlignmentIssue(shot, item));
		}
	}

	const layers = shotLayers(project, shot);
	const cleanPlates = layers.filter(({item}) => {
		return item.layerId === 'clean-plate' && item.opacity > 0;
	});
	if (cleanPlates.length === 0) {
		return issues;
	}

	const canvas: Rect = {
		left: 0,
		top: 0,
		width: project.compositionWidth,
		height: project.compositionHeight,
	};

	for (const localFrame of sampleFrames(shot, layers)) {
		const coverage = cleanPlates.some(({item}) => {
			const pose = evaluateImagePose({
				item,
				shot,
				globalFrame: shot.from + localFrame,
				compositionWidth: project.compositionWidth,
				compositionHeight: project.compositionHeight,
				fadeOpacity: 1,
			});
			if (pose.opacity <= 0.01) {
				return false;
			}

			return poseCoversCanvas(pose, canvas);
		});

		if (!coverage) {
			const plate = cleanPlates[0]?.item;
			if (plate) {
				return [...issues, exposureIssue(shot, plate, localFrame)];
			}
		}
	}

	return issues;
};

export const validateMotionExposureForProject = (
	project: UndoableState,
): ProjectIssue[] => {
	return (project.shots ?? []).flatMap((shot) => {
		return validateMotionExposure(project, shot);
	});
};
