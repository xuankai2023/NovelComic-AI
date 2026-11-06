import type {
	AdvancedTransform,
	AdvancedTransformAnimation,
	LayerNode,
} from '../composition/types';
import type {
	CameraAnimation,
	TransformAnimation,
	TransformKeyframe,
} from '../motion/types';
import {EASING_NAMES} from '../motion/types';
import type {UndoableState} from '../state/types';
import type {
	NumericKeyframe,
	NumericProperty,
	PropertyGraphV1,
	PropertyMigrationWarning,
	PropertyOwner,
	PropertySet,
} from './types';
import {createEmptyPropertyGraph, propertySetId} from './types';

const finite = (value: number | undefined, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const validHandle = (
	handle: TransformKeyframe['handleIn'],
): handle is NonNullable<TransformKeyframe['handleIn']> =>
	Boolean(
		handle &&
		Number.isFinite(handle.x) &&
		Number.isFinite(handle.y) &&
		handle.x >= 0 &&
		handle.x <= 1 &&
		handle.y >= -1 &&
		handle.y <= 2,
	);

type LegacyKeyframe = TransformKeyframe & {scale?: number};

const legacyLoopFields = (
	animation:
		| {
				loop?: PropertySet['loop'];
				loopStartFrame?: number;
				loopEndFrame?: number;
		  }
		| undefined,
): Pick<PropertySet, 'loop' | 'loopStartFrame' | 'loopEndFrame'> => {
	if (!animation?.loop || animation.loop === 'none') return {loop: 'none'};
	if (
		!Number.isInteger(animation.loopStartFrame) ||
		!Number.isInteger(animation.loopEndFrame) ||
		animation.loopEndFrame! < animation.loopStartFrame!
	) {
		return {loop: 'none'};
	}
	return {
		loop: animation.loop,
		loopStartFrame: animation.loopStartFrame,
		loopEndFrame: animation.loopEndFrame,
	};
};

const numericProperty = ({
	baseValue,
	keyframes,
	key,
	mapValue,
}: {
	baseValue: number;
	keyframes: readonly LegacyKeyframe[];
	key: keyof LegacyKeyframe;
	mapValue?: (value: number) => number;
}): NumericProperty => ({
	baseValue,
	keyframes: keyframes.flatMap((keyframe): NumericKeyframe[] => {
		const value = keyframe[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) return [];
		return [
			{
				frame: keyframe.frame,
				value: mapValue ? mapValue(value) : value,
				easing:
					keyframe.easing &&
					(EASING_NAMES as readonly string[]).includes(keyframe.easing)
						? keyframe.easing
						: 'linear',
				...(typeof keyframe.hold === 'boolean' ? {hold: keyframe.hold} : {}),
				...(validHandle(keyframe.handleIn)
					? {handleIn: {...keyframe.handleIn}}
					: {}),
				...(validHandle(keyframe.handleOut)
					? {handleOut: {...keyframe.handleOut}}
					: {}),
			},
		];
	}),
});

export const propertySetFromTransform = (
	owner: PropertyOwner,
	animation: TransformAnimation | undefined,
): PropertySet => {
	const keyframes = animation?.keyframes ?? [];
	return {
		owner,
		...legacyLoopFields(animation),
		properties: {
			anchorX: numericProperty({
				baseValue: finite(animation?.anchorX, 0.5),
				keyframes,
				key: 'anchorX',
			}),
			anchorY: numericProperty({
				baseValue: finite(animation?.anchorY, 0.5),
				keyframes,
				key: 'anchorY',
			}),
			x: numericProperty({
				baseValue: finite(animation?.x, 0),
				keyframes,
				key: 'x',
			}),
			y: numericProperty({
				baseValue: finite(animation?.y, 0),
				keyframes,
				key: 'y',
			}),
			scaleX: numericProperty({
				baseValue: finite(animation?.scaleX, 1),
				keyframes,
				key: 'scaleX',
			}),
			scaleY: numericProperty({
				baseValue: finite(animation?.scaleY, 1),
				keyframes,
				key: 'scaleY',
			}),
			rotation: numericProperty({
				baseValue: finite(animation?.rotation, 0),
				keyframes,
				key: 'rotation',
			}),
			opacity: numericProperty({
				baseValue: finite(animation?.opacity, 1),
				keyframes,
				key: 'opacity',
			}),
		},
	};
};

export const propertySetFromCamera = (
	owner: PropertyOwner,
	animation: CameraAnimation | undefined,
): PropertySet => ({
	owner,
	...legacyLoopFields(animation),
	properties: {
		x: numericProperty({
			baseValue: 0,
			keyframes: animation?.keyframes ?? [],
			key: 'x',
		}),
		y: numericProperty({
			baseValue: 0,
			keyframes: animation?.keyframes ?? [],
			key: 'y',
		}),
		scale: numericProperty({
			baseValue: 1,
			keyframes: animation?.keyframes ?? [],
			key: 'scale',
		}),
	},
});

export const propertySetFromAdvancedTransform = (
	owner: PropertyOwner,
	transform: AdvancedTransform,
	motion: AdvancedTransformAnimation | undefined,
): PropertySet => {
	const keyframes = motion?.keyframes ?? [];
	return {
		owner,
		readOnly: true,
		...legacyLoopFields(motion),
		properties: {
			x: numericProperty({
				baseValue: transform.x,
				keyframes,
				key: 'x',
				mapValue: (value) => transform.x + value,
			}),
			y: numericProperty({
				baseValue: transform.y,
				keyframes,
				key: 'y',
				mapValue: (value) => transform.y + value,
			}),
			scaleX: numericProperty({
				baseValue: transform.scaleX,
				keyframes,
				key: 'scaleX',
				mapValue: (value) => transform.scaleX * value,
			}),
			scaleY: numericProperty({
				baseValue: transform.scaleY,
				keyframes,
				key: 'scaleY',
				mapValue: (value) => transform.scaleY * value,
			}),
			rotation: numericProperty({
				baseValue: transform.rotation,
				keyframes,
				key: 'rotation',
				mapValue: (value) => transform.rotation + value,
			}),
			opacity: numericProperty({
				baseValue: transform.opacity,
				keyframes,
				key: 'opacity',
				mapValue: (value) => transform.opacity * value,
			}),
		},
	};
};

const propertySetFromAdvancedLayer = (layer: LayerNode): PropertySet =>
	propertySetFromAdvancedTransform(
		{kind: 'advanced-layer', id: layer.id},
		layer.transform,
		layer.motion,
	);

const advancedWarnings = (layer: LayerNode): PropertyMigrationWarning[] => {
	const owner = {kind: 'advanced-layer', id: layer.id} as const;
	const warnings: PropertyMigrationWarning[] = [];
	if (layer.expressionIds?.length)
		warnings.push({
			owner,
			field: 'expressionIds',
			message:
				'Expressions are preserved and evaluated after the read-only PropertySet.',
		});
	if (layer.masks?.length)
		warnings.push({
			owner,
			field: 'masks',
			message:
				'Masks are preserved but are outside editable PropertyGraph properties.',
		});
	if (layer.matte)
		warnings.push({
			owner,
			field: 'matte',
			message:
				'Track matte data is preserved but is outside editable PropertyGraph properties.',
		});
	return warnings;
};

const invalidHandleWarnings = (
	owner: PropertyOwner,
	keyframes: readonly LegacyKeyframe[],
): PropertyMigrationWarning[] =>
	keyframes.flatMap((keyframe) => {
		if (
			(keyframe.handleIn && !validHandle(keyframe.handleIn)) ||
			(keyframe.handleOut && !validHandle(keyframe.handleOut))
		) {
			return [
				{
					owner,
					field: `keyframes[${keyframe.frame}].handle`,
					message:
						'Invalid curve handle was omitted during PropertyGraph migration; the original legacy field remains preserved.',
				},
			];
		}
		return [];
	});

const unsupportedKeyframeWarnings = (
	owner: PropertyOwner,
	keyframes: readonly LegacyKeyframe[],
): PropertyMigrationWarning[] =>
	keyframes.flatMap((keyframe) => {
		const fields: string[] = [];
		if (
			keyframe.easing !== undefined &&
			!(EASING_NAMES as readonly string[]).includes(keyframe.easing)
		) {
			fields.push('easing');
		}
		if (keyframe.hold !== undefined && typeof keyframe.hold !== 'boolean') {
			fields.push('hold');
		}
		return fields.map((field) => ({
			owner,
			field: `keyframes[${keyframe.frame}].${field}`,
			message: `Unsupported ${field} was replaced with its compatibility default during PropertyGraph migration; the original legacy field remains preserved.`,
		}));
	});

export const buildPropertyGraph = (state: UndoableState): PropertyGraphV1 => {
	const graph = createEmptyPropertyGraph();
	const warnings: PropertyMigrationWarning[] = [];
	for (const item of Object.values(state.items)) {
		if (item.type !== 'image') continue;
		const owner = {kind: 'item', id: item.id} as const;
		const set = propertySetFromTransform(owner, item.motion?.transform);
		graph.sets[propertySetId(set.owner)] = set;
		warnings.push(
			...invalidHandleWarnings(owner, item.motion?.transform?.keyframes ?? []),
		);
		warnings.push(
			...unsupportedKeyframeWarnings(
				owner,
				item.motion?.transform?.keyframes ?? [],
			),
		);
	}
	for (const shot of state.shots ?? []) {
		const set = propertySetFromCamera(
			{kind: 'shot', id: shot.id},
			shot.cameraMotion,
		);
		graph.sets[propertySetId(set.owner)] = set;
	}
	for (const layer of Object.values(state.advanced?.layers ?? {})) {
		const set = propertySetFromAdvancedLayer(layer);
		graph.sets[propertySetId(set.owner)] = set;
		warnings.push(...advancedWarnings(layer));
		warnings.push(
			...invalidHandleWarnings(set.owner, layer.motion?.keyframes ?? []),
		);
		warnings.push(
			...unsupportedKeyframeWarnings(set.owner, layer.motion?.keyframes ?? []),
		);
	}
	if (warnings.length > 0) graph.warnings = warnings;
	return graph;
};

export type MotionMigrationResult = {
	state: UndoableState;
	warnings: PropertyMigrationWarning[];
};

export const migrateMotionToPropertyGraph = (
	state: UndoableState,
): MotionMigrationResult => {
	if (state.propertyGraph?.version === 1) {
		const expected = buildPropertyGraph(state);
		const existingSets = Object.fromEntries(
			Object.entries(state.propertyGraph.sets).filter(
				([id]) => id in expected.sets && !expected.sets[id]?.readOnly,
			),
		);
		const propertyGraph: PropertyGraphV1 = {
			...state.propertyGraph,
			sets: {...expected.sets, ...existingSets},
			warnings: state.propertyGraph.warnings ?? expected.warnings,
		};
		return {
			state: {...state, schemaVersion: 3, propertyGraph},
			warnings: propertyGraph.warnings ?? [],
		};
	}
	const propertyGraph = buildPropertyGraph(state);
	return {
		state: {...state, schemaVersion: 3, propertyGraph},
		warnings: propertyGraph.warnings ?? [],
	};
};
