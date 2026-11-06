import type {
	AdvancedTransform,
	AdvancedTransformAnimation,
	LayerNode,
} from '../composition/types';
import {evaluatePropertyGraph} from '../property/evaluate-property';
import {propertySetFromAdvancedTransform} from '../property/migrate-motion';
import {PROPERTY_GRAPH_VERSION, propertySetId} from '../property/types';

export type EvaluatedTransform = AdvancedTransform;

export const evaluateLocalTransform = (
	transform: AdvancedTransform,
	motion: AdvancedTransformAnimation | undefined,
	frame: number,
	duration?: number,
): EvaluatedTransform => {
	const owner = {kind: 'advanced-layer', id: '__legacy-advanced__'} as const;
	const set = propertySetFromAdvancedTransform(owner, transform, motion);
	const durationInFrames =
		duration && duration > 0
			? Math.floor(duration)
			: Math.max(
					1,
					Math.floor(frame) + 1,
					...(motion?.keyframes ?? []).map((keyframe) => keyframe.frame + 1),
				);
	const values = evaluatePropertyGraph({
		graph: {
			version: PROPERTY_GRAPH_VERSION,
			sets: {[propertySetId(owner)]: set},
		},
		owner,
		frame,
		durationInFrames,
		validationMode: 'compatibility',
	});
	return {
		...transform,
		x: values.x!,
		y: values.y!,
		scaleX: values.scaleX!,
		scaleY: values.scaleY!,
		rotation: values.rotation!,
		opacity: values.opacity!,
	};
};

export const combineParentTransform = (
	local: EvaluatedTransform,
	parent: EvaluatedTransform,
): EvaluatedTransform => {
	const radians = (parent.rotation * Math.PI) / 180;
	const scaledX = local.x * parent.scaleX;
	const scaledY = local.y * parent.scaleY;
	return {
		...local,
		x: parent.x + scaledX * Math.cos(radians) - scaledY * Math.sin(radians),
		y: parent.y + scaledX * Math.sin(radians) + scaledY * Math.cos(radians),
		scaleX: parent.scaleX * local.scaleX,
		scaleY: parent.scaleY * local.scaleY,
		rotation: parent.rotation + local.rotation,
		opacity: parent.opacity * local.opacity,
	};
};

export const resolveWorldTransform = (
	layerId: string,
	layers: Record<string, LayerNode>,
	frame: number,
): EvaluatedTransform => {
	const visiting = new Set<string>();
	const cache = new Map<string, EvaluatedTransform>();

	const visit = (id: string): EvaluatedTransform => {
		const cached = cache.get(id);
		if (cached) {
			return cached;
		}

		if (visiting.has(id)) {
			throw new Error(`Layer hierarchy contains a cycle at ${id}`);
		}

		const layer = layers[id];
		if (!layer) {
			throw new Error(`Layer ${id} does not exist`);
		}

		visiting.add(id);
		const local = evaluateLocalTransform(
			layer.transform,
			layer.motion,
			frame - (layer.from ?? 0),
		);
		const world = layer.parentId
			? combineParentTransform(local, visit(layer.parentId))
			: local;
		visiting.delete(id);
		cache.set(id, world);
		return world;
	};

	return visit(layerId);
};
