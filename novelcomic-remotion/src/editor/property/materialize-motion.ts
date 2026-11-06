import type {AdvancedTransformKeyframe} from '../composition/types';
import type {
	CameraAnimation,
	CameraKeyframe,
	TransformAnimation,
	TransformKeyframe,
} from '../motion/types';
import type {UndoableState} from '../state/types';
import {
	buildPropertyGraph,
	propertySetFromCamera,
	propertySetFromTransform,
} from './migrate-motion';
import type {NumericKeyframe, PropertySet} from './types';
import {propertySetId} from './types';

const copyKeyframe = (keyframe: NumericKeyframe) => ({
	frame: keyframe.frame,
	easing: keyframe.easing,
	...(keyframe.hold === undefined ? {} : {hold: keyframe.hold}),
	...(keyframe.handleIn ? {handleIn: {...keyframe.handleIn}} : {}),
	...(keyframe.handleOut ? {handleOut: {...keyframe.handleOut}} : {}),
});

const mergeProperties = <T extends {frame: number}>(
	set: PropertySet,
	keys: readonly string[],
	mapValue?: (key: string, value: number) => number,
): T[] => {
	const frames = new Map<number, Record<string, unknown>>();
	for (const key of keys) {
		for (const keyframe of set.properties[key]?.keyframes ?? []) {
			const current = frames.get(keyframe.frame) ?? {frame: keyframe.frame};
			Object.assign(current, copyKeyframe(keyframe), {
				[key]: mapValue ? mapValue(key, keyframe.value) : keyframe.value,
			});
			frames.set(keyframe.frame, current);
		}
	}
	return [...frames.values()].sort(
		(a, b) => Number(a.frame) - Number(b.frame),
	) as T[];
};

const loopFields = (set: PropertySet) => ({
	...(set.loop === 'none' ? {} : {loop: set.loop}),
	...(set.loopStartFrame === undefined
		? {}
		: {loopStartFrame: set.loopStartFrame}),
	...(set.loopEndFrame === undefined ? {} : {loopEndFrame: set.loopEndFrame}),
});

export const materializeTransformAnimation = (
	set: PropertySet,
): TransformAnimation => ({
	keyframes: mergeProperties<TransformKeyframe>(set, [
		'anchorX',
		'anchorY',
		'x',
		'y',
		'scaleX',
		'scaleY',
		'rotation',
		'opacity',
	]),
	animatedProperties: [
		...(set.properties.anchorX?.keyframes.length ||
		set.properties.anchorY?.keyframes.length
			? ['anchorPoint' as const]
			: []),
		...(set.properties.x?.keyframes.length || set.properties.y?.keyframes.length
			? ['position' as const]
			: []),
		...(set.properties.scaleX?.keyframes.length ||
		set.properties.scaleY?.keyframes.length
			? ['scale' as const]
			: []),
		...(set.properties.rotation?.keyframes.length ? ['rotation' as const] : []),
		...(set.properties.opacity?.keyframes.length ? ['opacity' as const] : []),
	],
	anchorX: set.properties.anchorX?.baseValue ?? 0.5,
	anchorY: set.properties.anchorY?.baseValue ?? 0.5,
	x: set.properties.x?.baseValue ?? 0,
	y: set.properties.y?.baseValue ?? 0,
	scaleX: set.properties.scaleX?.baseValue ?? 1,
	scaleY: set.properties.scaleY?.baseValue ?? 1,
	rotation: set.properties.rotation?.baseValue ?? 0,
	opacity: set.properties.opacity?.baseValue ?? 1,
	...loopFields(set),
});

export const materializeCameraAnimation = (
	set: PropertySet,
	legacy?: CameraAnimation,
): CameraAnimation => ({
	keyframes: mergeProperties<CameraKeyframe>(set, ['x', 'y', 'scale']),
	...(legacy?.focalX === undefined ? {} : {focalX: legacy.focalX}),
	...(legacy?.focalY === undefined ? {} : {focalY: legacy.focalY}),
	...loopFields(set),
});

const isDefaultCameraSet = (set: PropertySet): boolean =>
	set.loop === 'none' &&
	(set.properties.x?.baseValue ?? 0) === 0 &&
	(set.properties.y?.baseValue ?? 0) === 0 &&
	(set.properties.scale?.baseValue ?? 1) === 1 &&
	Object.values(set.properties).every(
		(property) => property.keyframes.length === 0,
	);

const isDefaultTransformSet = (set: PropertySet): boolean =>
	set.loop === 'none' &&
	(set.properties.anchorX?.baseValue ?? 0.5) === 0.5 &&
	(set.properties.anchorY?.baseValue ?? 0.5) === 0.5 &&
	(set.properties.x?.baseValue ?? 0) === 0 &&
	(set.properties.y?.baseValue ?? 0) === 0 &&
	(set.properties.scaleX?.baseValue ?? 1) === 1 &&
	(set.properties.scaleY?.baseValue ?? 1) === 1 &&
	(set.properties.rotation?.baseValue ?? 0) === 0 &&
	(set.properties.opacity?.baseValue ?? 1) === 1 &&
	Object.values(set.properties).every(
		(property) => property.keyframes.length === 0,
	);

type MaterializableMotionState = Pick<
	UndoableState,
	'items' | 'shots' | 'advanced' | 'propertyGraph'
>;

export const materializeLegacyMotion = <T extends MaterializableMotionState>(
	state: T,
): T => {
	const graph = state.propertyGraph;
	if (!graph) return state;
	const items = {...state.items};
	for (const item of Object.values(items)) {
		if (item.type !== 'image') continue;
		const set = graph.sets[propertySetId({kind: 'item', id: item.id})];
		if (!set) continue;
		if (isDefaultTransformSet(set)) {
			if (!item.motion?.transform) continue;
			const motion = {...item.motion};
			delete motion.transform;
			if (Object.keys(motion).length === 0) {
				const next = {...item};
				delete next.motion;
				items[item.id] = next;
			} else {
				items[item.id] = {...item, motion};
			}
			continue;
		}
		items[item.id] = {
			...item,
			motion: {
				...(item.motion ?? {}),
				transform: materializeTransformAnimation(set),
			},
		};
	}
	const shots = (state.shots ?? []).map((shot) => {
		const set = graph.sets[propertySetId({kind: 'shot', id: shot.id})];
		if (!set) return shot;
		if (isDefaultCameraSet(set)) {
			const next = {...shot};
			delete next.cameraMotion;
			return next;
		}
		return {
			...shot,
			cameraMotion: materializeCameraAnimation(set, shot.cameraMotion),
		};
	});
	const advanced = state.advanced
		? {...state.advanced, layers: {...state.advanced.layers}}
		: undefined;
	if (advanced) {
		for (const layer of Object.values(advanced.layers)) {
			const set =
				graph.sets[propertySetId({kind: 'advanced-layer', id: layer.id})];
			if (!set) continue;
			const base = layer.transform;
			advanced.layers[layer.id] = {
				...layer,
				motion: {
					keyframes: mergeProperties<AdvancedTransformKeyframe>(
						set,
						['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'],
						(key, value) => {
							if (key === 'opacity' && base.opacity === 0) return 1;
							if (key === 'scaleX' || key === 'scaleY' || key === 'opacity')
								return value / base[key];
							return value - base[key as 'x' | 'y' | 'rotation'];
						},
					),
					...loopFields(set),
				},
			};
		}
	}
	return {...state, items, shots, ...(advanced ? {advanced} : {})};
};

export const writePropertySet = <T extends UndoableState>(
	state: T,
	set: PropertySet,
): T => {
	const graph = state.propertyGraph ?? buildPropertyGraph(state);
	return materializeLegacyMotion({
		...state,
		schemaVersion: 3,
		propertyGraph: {
			...graph,
			sets: {...graph.sets, [propertySetId(set.owner)]: set},
		},
	});
};

export const writeItemTransformPropertySet = <T extends UndoableState>(
	state: T,
	itemId: string,
	animation: TransformAnimation | undefined,
): T =>
	writePropertySet(
		state,
		propertySetFromTransform({kind: 'item', id: itemId}, animation),
	);

export const writeShotCameraPropertySet = <T extends UndoableState>(
	state: T,
	shotId: string,
	animation: CameraAnimation | undefined,
): T =>
	writePropertySet(
		state,
		propertySetFromCamera({kind: 'shot', id: shotId}, animation),
	);
