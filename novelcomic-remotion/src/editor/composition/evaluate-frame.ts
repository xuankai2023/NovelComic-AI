import {
	evaluateExpression,
	expressionValueAsNumber,
} from '../advanced/expressions';
import {
	combineParentTransform,
	evaluateLocalTransform,
	resolveWorldTransform,
} from '../hierarchy/resolve-parent-transform';
import {validateTrackMattes} from '../masks/track-matte';
import {resolvePrecomposeFrame} from './precompose';
import type {
	AdvancedProjectState,
	LayerNode,
	MouthState,
	SubtitleItem,
} from './types';

export type EvaluatedAdvancedLayer = {
	id: string;
	itemId?: string;
	name: string;
	visible: boolean;
	locked: boolean;
	zIndex: number;
	from: number;
	durationInFrames: number;
	opacity: number;
	blendMode: LayerNode['blendMode'];
	transform: ReturnType<typeof resolveWorldTransform>;
	masks: LayerNode['masks'];
	matte?: LayerNode['matte'];
	expressionDiagnostics?: string[];
	spriteAssetId?: string;
	sourceCompositionId?: string;
	childFrame?: number;
};

export type EvaluatedAdvancedFrame = {
	compositionId: string;
	frame: number;
	layers: EvaluatedAdvancedLayer[];
	subtitles: SubtitleItem[];
};

const stateAtFrame = (
	states: readonly MouthState[],
	frame: number,
	fallbackState: string,
): string => {
	const active = states.find(
		(state) => frame >= state.from && frame < state.to,
	);
	return active?.assetId ?? fallbackState;
};

const subtitleItemsAtFrame = (
	state: AdvancedProjectState,
	frame: number,
): SubtitleItem[] => {
	return Object.values(state.subtitles).flatMap((track) =>
		track.items.filter(
			(item) => frame >= item.from && frame < item.from + item.durationInFrames,
		),
	);
};

const isLayerActive = (
	layer: LayerNode,
	compositionDurationInFrames: number,
	frame: number,
): boolean => {
	const from = layer.from ?? 0;
	const duration = layer.durationInFrames ?? compositionDurationInFrames;
	return duration > 0 && frame >= from && frame < from + duration;
};

const readLayerAncestors = (
	state: AdvancedProjectState,
	layer: LayerNode,
): LayerNode[] => {
	const ancestors: LayerNode[] = [];
	const visited = new Set<string>();
	let current = layer.parentId ? state.layers[layer.parentId] : undefined;

	while (current) {
		if (visited.has(current.id)) {
			throw new Error(`Layer hierarchy contains a cycle at ${current.id}`);
		}
		visited.add(current.id);
		ancestors.push(current);
		current = current.parentId ? state.layers[current.parentId] : undefined;
	}

	return ancestors;
};

const isLayerVisible = (
	state: AdvancedProjectState,
	layer: LayerNode,
	compositionDurationInFrames: number,
	frame: number,
): boolean => {
	return (
		layer.visible &&
		readLayerAncestors(state, layer).every(
			(parent) =>
				parent.visible &&
				isLayerActive(parent, compositionDurationInFrames, frame),
		)
	);
};

const isLayerLocked = (
	state: AdvancedProjectState,
	layer: LayerNode,
): boolean => {
	return (
		layer.locked ||
		readLayerAncestors(state, layer).some((parent) => parent.locked)
	);
};

type EvaluatedTransform = ReturnType<typeof resolveWorldTransform>;

const expressionValueForProperty = (
	transform: EvaluatedTransform,
	property: keyof Pick<
		EvaluatedTransform,
		'x' | 'y' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity'
	>,
): number => transform[property];

const resolveWorldTransformWithExpressions = (
	state: AdvancedProjectState,
	layerId: string,
	frame: number,
): {transform: EvaluatedTransform; diagnostics: string[]} => {
	const visiting = new Set<string>();
	const cache = new Map<string, EvaluatedTransform>();
	const diagnostics: string[] = [];
	const fps = state.compositions[state.rootCompositionId]?.fps ?? 30;

	const visit = (id: string): EvaluatedTransform => {
		const cached = cache.get(id);
		if (cached) return cached;
		if (visiting.has(id)) {
			throw new Error(`Layer hierarchy contains a cycle at ${id}`);
		}

		const layer = state.layers[id];
		if (!layer) throw new Error(`Layer ${id} does not exist`);
		visiting.add(id);

		let local = evaluateLocalTransform(
			layer.transform,
			layer.motion,
			frame - (layer.from ?? 0),
			layer.durationInFrames ??
				state.compositions[layer.compositionId]?.durationInFrames,
		);
		for (const expressionId of layer.expressionIds ?? []) {
			const expression = state.expressions?.[expressionId];
			if (!expression || !expression.enabled) continue;
			const property = expression.property;
			const fallback = expressionValueForProperty(local, property);
			const result = evaluateExpression(
				expression.ast,
				{
					time: frame / fps,
					frame,
					fps,
					value: fallback,
					seed: expression.seed ?? 0,
				},
				fallback,
			);
			local = {
				...local,
				[property]: expressionValueAsNumber(result.value, fallback),
			};
			if (result.diagnostics.length > 0) {
				diagnostics.push(
					`${layer.name}/${property}: ${result.diagnostics.join(', ')}`,
				);
			}
		}

		const world = layer.parentId
			? combineParentTransform(local, visit(layer.parentId))
			: local;
		visiting.delete(id);
		cache.set(id, world);
		return world;
	};

	return {transform: visit(layerId), diagnostics};
};

type LayerCollectionContext = {
	globalStart: number;
	globalEnd: number;
	inheritedTransform?: EvaluatedTransform;
	inheritedLocked: boolean;
	inheritedVisible: boolean;
};

const getGlobalLayerTiming = ({
	context,
	layer,
	composition,
}: {
	context: LayerCollectionContext;
	layer: LayerNode;
	composition: {
		durationInFrames: number;
	};
}) => {
	const from = layer.from ?? 0;
	const duration = Math.max(
		Math.min(
			layer.durationInFrames ?? composition.durationInFrames - from,
			composition.durationInFrames - from,
			context.globalEnd - (context.globalStart + from),
		),
	);

	return {
		from: context.globalStart + from,
		durationInFrames: Math.max(0, duration),
	};
};

const collectCompositionLayers = ({
	state,
	compositionId,
	frame,
	context,
	output,
	order,
	visitedCompositions,
}: {
	state: AdvancedProjectState;
	compositionId: string;
	frame: number;
	context: LayerCollectionContext;
	output: EvaluatedAdvancedLayer[];
	order: {value: number};
	visitedCompositions: Set<string>;
}) => {
	const composition = state.compositions[compositionId];
	if (!composition) {
		throw new Error(`Composition ${compositionId} does not exist`);
	}
	const matteIssues = new Map(
		validateTrackMattes(state, compositionId).map((issue) => [
			issue.layerId,
			issue.message,
		]),
	);
	if (visitedCompositions.has(compositionId)) {
		throw new Error(
			`Composition hierarchy contains a cycle at ${compositionId}`,
		);
	}

	visitedCompositions.add(compositionId);
	const orderedLayers = composition.layerIds
		.map((layerId) => state.layers[layerId])
		.filter((layer): layer is LayerNode => Boolean(layer))
		.sort((left, right) => left.zIndex - right.zIndex);

	for (const layer of orderedLayers) {
		if (!isLayerActive(layer, composition.durationInFrames, frame)) {
			continue;
		}

		const visible =
			context.inheritedVisible &&
			isLayerVisible(state, layer, composition.durationInFrames, frame);
		if (!visible) {
			continue;
		}

		const resolved = resolveWorldTransformWithExpressions(
			state,
			layer.id,
			frame,
		);
		const transform = combineParentTransform(
			resolved.transform,
			context.inheritedTransform ?? {
				x: 0,
				y: 0,
				width: 0,
				height: 0,
				scaleX: 1,
				scaleY: 1,
				rotation: 0,
				opacity: 1,
				anchorX: 0.5,
				anchorY: 0.5,
			},
		);
		const locked = context.inheritedLocked || isLayerLocked(state, layer);
		const childComposition = layer.sourceCompositionId
			? state.compositions[layer.sourceCompositionId]
			: undefined;

		if (childComposition) {
			const childFrame = resolvePrecomposeFrame({
				parentFrame: frame,
				from: layer.from ?? 0,
				timeOffset: childComposition.timeOffset ?? 0,
				durationInFrames: childComposition.durationInFrames,
			});

			if (childFrame !== null) {
				collectCompositionLayers({
					state,
					compositionId: childComposition.id,
					frame: childFrame,
					context: {
						globalStart:
							context.globalStart +
							(layer.from ?? 0) -
							(childComposition.timeOffset ?? 0),
						globalEnd: Math.min(
							context.globalEnd,
							context.globalStart +
								(layer.from ?? 0) +
								(layer.durationInFrames ??
									composition.durationInFrames - (layer.from ?? 0)),
							context.globalStart +
								(layer.from ?? 0) -
								(childComposition.timeOffset ?? 0) +
								childComposition.durationInFrames,
						),
						inheritedTransform: transform,
						inheritedLocked: locked,
						inheritedVisible: visible,
					},
					output,
					order,
					visitedCompositions,
				});
			}
			continue;
		}

		const lipSync = Object.values(state.lipSyncTracks).find(
			(track) => track.mouthLayerId === layer.id,
		);
		const timing = getGlobalLayerTiming({
			context,
			layer,
			composition,
		});

		output.push({
			id: layer.id,
			...(layer.itemId ? {itemId: layer.itemId} : {}),
			name: layer.name,
			visible: true,
			locked,
			zIndex: order.value++,
			...timing,
			opacity: transform.opacity,
			blendMode: layer.blendMode,
			transform,
			masks: layer.masks,
			...(layer.matte && !matteIssues.has(layer.id)
				? {matte: layer.matte}
				: {}),
			...(resolved.diagnostics.length > 0 || matteIssues.has(layer.id)
				? {
						expressionDiagnostics: [
							...resolved.diagnostics,
							...(matteIssues.has(layer.id)
								? [matteIssues.get(layer.id)!]
								: []),
						],
					}
				: {}),
			...(lipSync
				? {
						spriteAssetId: stateAtFrame(
							lipSync.states,
							frame,
							lipSync.fallbackState,
						),
					}
				: {}),
		});
	}

	visitedCompositions.delete(compositionId);
};

export const evaluateAdvancedFrame = (
	state: AdvancedProjectState,
	compositionId = state.rootCompositionId,
	frame: number,
): EvaluatedAdvancedFrame => {
	if (!state.compositions[compositionId]) {
		throw new Error(`Composition ${compositionId} does not exist`);
	}

	const layers: EvaluatedAdvancedLayer[] = [];
	collectCompositionLayers({
		state,
		compositionId,
		frame,
		context: {
			globalStart: 0,
			globalEnd: state.compositions[compositionId]!.durationInFrames,
			inheritedLocked: false,
			inheritedVisible: true,
		},
		output: layers,
		order: {value: 0},
		visitedCompositions: new Set<string>(),
	});

	return {
		compositionId,
		frame,
		layers,
		subtitles:
			compositionId === state.rootCompositionId
				? subtitleItemsAtFrame(state, frame)
				: [],
	};
};
