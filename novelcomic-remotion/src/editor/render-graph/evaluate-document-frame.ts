import type {DocumentState, LayerNode} from '../document';
import {childLayerIds, isDescendant} from '../document/tree';
import type {
	EvaluatedDocumentFrame,
	EvaluatedLayerTransform,
	EvaluatedRenderLayer,
	RenderQuality,
} from './types';

type NumericTransform = EvaluatedLayerTransform;
type AnimatedTransformProperty =
	| 'x'
	| 'y'
	| 'width'
	| 'height'
	| 'rotation'
	| 'scaleX'
	| 'scaleY'
	| 'opacity';

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

const ease = (value: number, easing: string) => {
	const t = clamp(value, 0, 1);
	if (easing === 'hold') return 0;
	if (easing === 'ease-in') return t * t;
	if (easing === 'ease-out') return 1 - (1 - t) * (1 - t);
	if (easing === 'ease-in-out')
		return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
	return t;
};

const animatedValue = (
	layer: LayerNode,
	property: AnimatedTransformProperty,
	baseValue: number,
	frame: number,
): number => {
	const track = layer.animation?.properties[property];
	if (!track || track.keyframes.length === 0) return baseValue;
	const keyframes = track.keyframes.slice().sort((a, b) => a.frame - b.frame);
	const first = keyframes[0]!;
	if (frame <= first.frame) return first.value;
	const last = keyframes[keyframes.length - 1]!;
	if (frame >= last.frame) return last.value;
	for (let index = 1; index < keyframes.length; index += 1) {
		const next = keyframes[index]!;
		const previous = keyframes[index - 1]!;
		if (frame <= next.frame) {
			const span = next.frame - previous.frame;
			const progress = span <= 0 ? 1 : (frame - previous.frame) / span;
			return (
				previous.value +
				(next.value - previous.value) * ease(progress, next.easing)
			);
		}
	}
	return track.baseValue;
};

const localTransform = (layer: LayerNode, frame: number): NumericTransform => {
	const transform = layer.transform;
	return {
		...transform,
		x: animatedValue(layer, 'x', transform.originX, frame),
		y: animatedValue(layer, 'y', transform.originY, frame),
		width: animatedValue(layer, 'width', transform.width, frame),
		height: animatedValue(layer, 'height', transform.height, frame),
		rotation: animatedValue(layer, 'rotation', transform.rotation, frame),
		scaleX: animatedValue(layer, 'scaleX', transform.scaleX, frame),
		scaleY: animatedValue(layer, 'scaleY', transform.scaleY, frame),
		opacity: animatedValue(layer, 'opacity', layer.opacity, frame),
		worldScaleX: animatedValue(layer, 'scaleX', transform.scaleX, frame),
		worldScaleY: animatedValue(layer, 'scaleY', transform.scaleY, frame),
		worldRotation: animatedValue(layer, 'rotation', transform.rotation, frame),
	};
};
const placementTransform = (
	layer: LayerNode,
	frame: number,
): NumericTransform => {
	const placement = layer.mask?.placement ?? layer.transform;
	return {
		...placement,
		x: placement.originX,
		y: placement.originY,
		opacity: animatedValue(layer, 'opacity', layer.opacity, frame),
		worldScaleX: placement.scaleX,
		worldScaleY: placement.scaleY,
		worldRotation: placement.rotation,
	};
};

const combine = (
	local: NumericTransform,
	parent: NumericTransform | undefined,
): NumericTransform => {
	if (!parent) return local;
	const radians = (parent.worldRotation * Math.PI) / 180;
	const x = local.x * parent.worldScaleX;
	const y = local.y * parent.worldScaleY;
	return {
		...local,
		x: parent.x + x * Math.cos(radians) - y * Math.sin(radians),
		y: parent.y + x * Math.sin(radians) + y * Math.cos(radians),
		scaleX: local.scaleX * parent.scaleX,
		scaleY: local.scaleY * parent.scaleY,
		rotation: local.rotation + parent.rotation,
		opacity: clamp(local.opacity * parent.opacity, 0, 1),
		worldScaleX: local.worldScaleX * parent.worldScaleX,
		worldScaleY: local.worldScaleY * parent.worldScaleY,
		worldRotation: local.worldRotation + parent.worldRotation,
	};
};

const ancestorIds = (document: DocumentState, layer: LayerNode): string[] => {
	const result: string[] = [];
	let parentId = layer.parentId;
	while (parentId) {
		result.push(parentId);
		parentId = document.layers[parentId]?.parentId ?? null;
	}
	return result.reverse();
};

const durationAtFrame = (document: DocumentState, frame: number) => {
	const duration = document.animation?.durationInFrames ?? 1;
	return Math.max(0, Math.floor(frame)) < duration;
};

export type EvaluateDocumentFrameInput = {
	document: DocumentState;
	frame?: number;
	quality?: RenderQuality;
};

export const evaluateDocumentFrame = ({
	document,
	frame = 0,
	quality = 'preview',
}: EvaluateDocumentFrameInput): EvaluatedDocumentFrame => {
	const currentFrame = Math.max(0, Math.floor(frame));
	const soloIds = new Set(
		Object.values(document.layers)
			.filter((layer) => layer.solo)
			.map((layer) => layer.id),
	);
	const flattened: EvaluatedRenderLayer[] = [];

	const evaluate = (
		id: string,
		parentTransform?: NumericTransform,
		inheritedVisible = true,
		ancestors: string[] = [],
		inheritedMasks: EvaluatedRenderLayer['effectiveMasks'] = [],
	) => {
		const layer = document.layers[id];
		if (!layer) return;
		const local = localTransform(layer, currentFrame);
		const world = combine(local, parentTransform);
		const ownVisible = layer.visible && durationAtFrame(document, currentFrame);
		const soloVisible =
			soloIds.size === 0 ||
			soloIds.has(layer.id) ||
			ancestors.some((ancestor) => soloIds.has(ancestor));
		const isVisible = inheritedVisible && ownVisible && soloVisible;
		const ownMask = layer.mask
			? {
					mask: layer.mask,
					transform: layer.mask.linkedToLayer
						? world
						: combine(placementTransform(layer, currentFrame), parentTransform),
				}
			: undefined;
		const effectiveMasks = ownMask
			? [...inheritedMasks, ownMask]
			: inheritedMasks;
		flattened.push({
			id: layer.id,
			name: layer.name,
			kind: layer.kind,
			parentId: layer.parentId,
			order: layer.order,
			visible: isVisible,
			locked:
				layer.locked ||
				ancestors.some((ancestor) => document.layers[ancestor]?.locked),
			opacity: world.opacity,
			blendMode: layer.blendMode,
			transform: world,
			content: layer.content,
			...(ownMask ? {mask: ownMask} : {}),
			effectiveMasks,
			...(layer.liveMask
				? {liveMask: layer.liveMask}
				: layer.liveMaskSourceId
					? {
							liveMask: {
								sourceLayerId: layer.liveMaskSourceId,
								mode: 'alpha' as const,
							},
						}
					: {}),
			...(layer.effects ? {effects: layer.effects} : {}),
			ancestors,
		});
		if (layer.kind === 'group') {
			for (const childId of childLayerIds(document, layer.id))
				evaluate(
					childId,
					world,
					isVisible,
					[...ancestors, layer.id],
					effectiveMasks,
				);
		}
	};

	for (const id of document.rootLayerIds) evaluate(id);
	const nodes = flattened
		.filter((layer) => layer.visible)
		.map((layer) =>
			layer.kind === 'adjustment'
				? {
						kind: 'adjustment' as const,
						layer,
							inputNodeIds: flattened
								.filter(
									(candidate) =>
										candidate.visible &&
										candidate.kind !== 'group' &&
										candidate.order < layer.order &&
										candidate.parentId === layer.parentId,
									)
								.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
								.map((candidate) => candidate.id),
					}
				: {kind: 'layer' as const, layer},
		);
	return {
		documentId: document.documentId,
		frame: currentFrame,
		width: document.width,
		height: document.height,
		quality,
		nodes,
		layers: flattened,
		background: {r: 0, g: 0, b: 0, a: 0},
	};
};

export const evaluateLayerTransform = (
	document: DocumentState,
	layerId: string,
	frame = 0,
): EvaluatedLayerTransform | undefined => {
	const layer = document.layers[layerId];
	if (!layer) return undefined;
	const parents = ancestorIds(document, layer);
	let transform: NumericTransform | undefined;
	for (const id of [...parents, layerId])
		transform = combine(localTransform(document.layers[id]!, frame), transform);
	return transform;
};

export const isLayerInTree = (
	document: DocumentState,
	layerId: string,
	ancestorId: string,
) => isDescendant(document, layerId, ancestorId);
