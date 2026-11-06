import type {CurveHandle, EasingName, TransformKeyframe} from './types';
import {applyEasing} from './easing';

export type CurveSample = {
	frame: number;
	value: number;
	easing?: EasingName;
	hold?: boolean;
	handleIn?: CurveHandle;
	handleOut?: CurveHandle;
};

const clamp = (value: number, min: number, max: number): number =>
	Math.max(min, Math.min(max, value));

const cubic = (
	start: number,
	controlStart: number,
	controlEnd: number,
	end: number,
	amount: number,
): number => {
	const inverse = 1 - amount;
	return (
		inverse * inverse * inverse * start +
		3 * inverse * inverse * amount * controlStart +
		3 * inverse * amount * amount * controlEnd +
		amount * amount * amount * end
	);
};

const cubicProgress = (
	amount: number,
	handleOut: CurveHandle | undefined,
	handleIn: CurveHandle | undefined,
): number => {
	if (!handleOut && !handleIn) {
		return amount;
	}

	const out = handleOut ?? {x: 0.33, y: 0.33};
	const incoming = handleIn ?? {x: 0.67, y: 0.67};
	let low = 0;
	let high = 1;
	for (let index = 0; index < 18; index++) {
		const middle = (low + high) / 2;
		const time = cubic(0, out.x, incoming.x, 1, middle);
		if (time < amount) low = middle;
		else high = middle;
	}
	const solved = (low + high) / 2;
	return cubic(0, out.y, incoming.y, 1, solved);
};

// Keyframe arrays are immutable across command commits. Cache their sorted
// index so playback does not allocate and sort every property on every frame.
const sortedPointsCache = new WeakMap<
	readonly CurveSample[],
	readonly CurveSample[]
>();

const sortedPointsFor = (
	points: readonly CurveSample[],
): readonly CurveSample[] => {
	const cached = sortedPointsCache.get(points);
	if (cached) return cached;
	const sorted = [...points].sort((left, right) => left.frame - right.frame);
	sortedPointsCache.set(points, sorted);
	return sorted;
};

const firstPointAtOrAfter = (
	points: readonly CurveSample[],
	frame: number,
): number => {
	let low = 0;
	let high = points.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (points[middle]!.frame < frame) low = middle + 1;
		else high = middle;
	}
	return low;
};

export const sampleCurve = (
	points: readonly CurveSample[],
	frame: number,
	fallback: number,
): number => {
	if (points.length === 0) return fallback;
	const ordered = sortedPointsFor(points);
	const first = ordered[0]!;
	if (frame <= first.frame) return first.value;
	const last = ordered[ordered.length - 1]!;
	if (frame >= last.frame) return last.value;
	const rightIndex = firstPointAtOrAfter(ordered, frame);
	const left = ordered[rightIndex - 1]!;
	const right = ordered[rightIndex]!;
	const span = right.frame - left.frame;
	if (span <= 0) return right.value;
	if (left.hold && frame < right.frame) return left.value;
	const amount = clamp((frame - left.frame) / span, 0, 1);
	const progress =
		left.handleOut || right.handleIn
			? cubicProgress(amount, left.handleOut, right.handleIn)
			: applyEasing(right.easing ?? 'linear', amount);
	if (left.handleOut || right.handleIn) {
		const leftHandleValue =
			left.value + (right.value - left.value) * (left.handleOut?.y ?? 0.33);
		const rightHandleValue =
			left.value + (right.value - left.value) * (right.handleIn?.y ?? 0.67);
		return cubic(
			left.value,
			leftHandleValue,
			rightHandleValue,
			right.value,
			progress,
		);
	}
	return left.value + (right.value - left.value) * progress;
};

export const curvePointsFor = (
	keyframes: readonly TransformKeyframe[],
	property: keyof Omit<TransformKeyframe, 'frame' | 'easing' | 'handleIn' | 'handleOut'>,
	fallback: number,
): CurveSample[] => {
	const points = keyframes.flatMap((keyframe) => {
		const value = keyframe[property];
		return typeof value === 'number' && Number.isFinite(value)
			? [
					{
						frame: keyframe.frame,
						value,
					easing: keyframe.easing,
					hold: keyframe.hold,
					handleIn: keyframe.handleIn,
						handleOut: keyframe.handleOut,
					},
				]
			: [];
	});
	return points.length > 0 ? points : [{frame: 0, value: fallback}];
};
