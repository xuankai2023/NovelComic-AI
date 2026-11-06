import type {Shot} from '../comic/types';
import type {AdvancedProjectState} from '../composition/types';
import type {EditorStarterItem} from '../items/item-type';
import {sampleCurve} from '../motion/curve';
import {EASING_NAMES, TRANSFORM_LOOPS} from '../motion/types';
import type {
	NumericKeyframe,
	PropertyGraphV1,
	PropertyOwner,
	PropertySet,
} from './types';
import {propertySetId} from './types';

export type EvaluatePropertyGraphInput = {
	graph: PropertyGraphV1;
	owner: PropertyOwner;
	frame: number;
	durationInFrames: number;
	validationMode?: 'strict' | 'compatibility';
};

export type EvaluatedPropertySet = Record<string, number>;

const positiveModulo = (value: number, modulus: number): number => {
	const remainder = value % modulus;
	return remainder < 0 ? remainder + modulus : remainder;
};

const remapLoopFrame = (frame: number, set: PropertySet): number => {
	if (set.loop === 'none') return frame;
	const start = set.loopStartFrame;
	const end = set.loopEndFrame;
	if (!Number.isInteger(start) || !Number.isInteger(end) || end! < start!) {
		throw new Error(
			`Property set ${propertySetId(set.owner)} has an invalid loop window`,
		);
	}
	const span = end! - start!;
	if (span === 0) return start!;
	const offset = frame - start!;
	if (set.loop === 'repeat') {
		return start! + positiveModulo(offset, span + 1);
	}
	const position = positiveModulo(offset, span * 2);
	return position <= span ? start! + position : end! - (position - span);
};

const assertHandle = (
	handle: NumericKeyframe['handleIn'],
	label: string,
): void => {
	if (!handle) return;
	if (
		!Number.isFinite(handle.x) ||
		!Number.isFinite(handle.y) ||
		handle.x < 0 ||
		handle.x > 1 ||
		handle.y < -1 ||
		handle.y > 2
	) {
		throw new Error(`${label} has an invalid curve handle`);
	}
};

export const validatePropertySet = (
	set: PropertySet,
	durationInFrames: number,
): void => {
	const id = propertySetId(set.owner);
	const allowedProperties: Record<PropertyOwner['kind'], readonly string[]> = {
		item: [
			'anchorX',
			'anchorY',
			'x',
			'y',
			'scaleX',
			'scaleY',
			'rotation',
			'opacity',
		],
		shot: ['x', 'y', 'scale'],
		'advanced-layer': ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity'],
	};
	if (!Number.isInteger(durationInFrames) || durationInFrames <= 0) {
		throw new Error(`Property set ${id} requires a positive integer duration`);
	}
	if (!(TRANSFORM_LOOPS as readonly string[]).includes(set.loop)) {
		throw new Error(`Property set ${id} has unknown loop ${String(set.loop)}`);
	}
	if (set.loop !== 'none') {
		remapLoopFrame(0, set);
		if (set.loopStartFrame! < 0 || set.loopEndFrame! >= durationInFrames) {
			throw new Error(`Property set ${id} loop window is outside its duration`);
		}
	}

	for (const [name, property] of Object.entries(set.properties)) {
		if (!allowedProperties[set.owner.kind].includes(name)) {
			throw new Error(`Property ${id}/${name} is not supported`);
		}
		if (!Number.isFinite(property.baseValue)) {
			throw new Error(`Property ${id}/${name} has a non-finite base value`);
		}
		if (
			(name === 'scale' || name === 'scaleX' || name === 'scaleY') &&
			property.baseValue <= 0
		) {
			throw new Error(`Property ${id}/${name} must be greater than 0`);
		}
		if (
			name === 'opacity' &&
			(property.baseValue < 0 || property.baseValue > 1)
		) {
			throw new Error(`Property ${id}/opacity must be between 0 and 1`);
		}
		const frames = new Set<number>();
		for (const keyframe of property.keyframes) {
			if (
				!Number.isInteger(keyframe.frame) ||
				keyframe.frame < 0 ||
				keyframe.frame >= durationInFrames
			) {
				throw new Error(`Property ${id}/${name} has an out-of-range keyframe`);
			}
			if (frames.has(keyframe.frame)) {
				throw new Error(
					`Property ${id}/${name} has duplicate frame ${keyframe.frame}`,
				);
			}
			frames.add(keyframe.frame);
			if (!Number.isFinite(keyframe.value)) {
				throw new Error(
					`Property ${id}/${name} has a non-finite keyframe value`,
				);
			}
			if (
				(name === 'scale' || name === 'scaleX' || name === 'scaleY') &&
				keyframe.value <= 0
			) {
				throw new Error(`Property ${id}/${name} must be greater than 0`);
			}
			if (name === 'opacity' && (keyframe.value < 0 || keyframe.value > 1)) {
				throw new Error(`Property ${id}/opacity must be between 0 and 1`);
			}
			if (!(EASING_NAMES as readonly string[]).includes(keyframe.easing)) {
				throw new Error(
					`Property ${id}/${name} has unknown easing ${String(keyframe.easing)}`,
				);
			}
			assertHandle(keyframe.handleIn, `Property ${id}/${name}`);
			assertHandle(keyframe.handleOut, `Property ${id}/${name}`);
		}
	}
};

export const evaluatePropertyGraph = ({
	graph,
	owner,
	frame,
	durationInFrames,
	validationMode = 'strict',
}: EvaluatePropertyGraphInput): EvaluatedPropertySet => {
	if (graph.version !== 1) {
		throw new Error(
			`Unsupported PropertyGraph version ${String(graph.version)}`,
		);
	}
	const id = propertySetId(owner);
	const set = graph.sets[id];
	if (!set) throw new Error(`Property set ${id} does not exist`);
	if (set.owner.kind !== owner.kind || set.owner.id !== owner.id) {
		throw new Error(`Property set ${id} owner does not match its key`);
	}
	if (validationMode === 'strict') validatePropertySet(set, durationInFrames);
	const clampedFrame = Math.max(
		0,
		Math.min(durationInFrames - 1, Number.isFinite(frame) ? frame : 0),
	);
	const sampleFrame = remapLoopFrame(clampedFrame, set);
	return Object.fromEntries(
		Object.entries(set.properties).map(([name, property]) => [
			name,
			sampleCurve(property.keyframes, sampleFrame, property.baseValue),
		]),
	);
};

export const validatePropertyGraph = ({
	graph,
	items,
	shots,
	advanced,
}: {
	graph: PropertyGraphV1;
	items: Record<string, EditorStarterItem>;
	shots: readonly Shot[];
	advanced?: AdvancedProjectState;
}): void => {
	if (graph.version !== 1) {
		throw new Error(
			`Unsupported PropertyGraph version ${String(graph.version)}`,
		);
	}
	for (const [id, set] of Object.entries(graph.sets)) {
		if (id !== propertySetId(set.owner)) {
			throw new Error(`Property set ${id} owner does not match its key`);
		}
		let durationInFrames: number | undefined;
		if (set.owner.kind === 'item') {
			durationInFrames = items[set.owner.id]?.durationInFrames;
		} else if (set.owner.kind === 'shot') {
			durationInFrames = shots.find(
				(shot) => shot.id === set.owner.id,
			)?.durationInFrames;
		} else {
			const layer = advanced?.layers[set.owner.id];
			const composition = layer
				? advanced?.compositions[layer.compositionId]
				: undefined;
			durationInFrames =
				layer?.durationInFrames ?? composition?.durationInFrames;
		}
		if (durationInFrames === undefined) {
			// Deletions may leave an orphaned compatibility set until the next
			// normalization pass. It cannot affect evaluation or materialization.
			continue;
		}
		validatePropertySet(set, durationInFrames);
	}
};
