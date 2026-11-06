import type {
	AdvancedProjectState,
	CompositionDefinition,
	LayerNode,
} from './types';

export type CreatePrecomposeInput = {
	compositionId: string;
	layerIds: string[];
	composition: Omit<
		CompositionDefinition,
		'id' | 'layerIds' | 'parentCompositionId'
	> & {
		id: string;
	};
	wrapper: Omit<LayerNode, 'compositionId' | 'sourceCompositionId'> & {
		id: string;
	};
};

const cloneState = (state: AdvancedProjectState): AdvancedProjectState => ({
	...state,
		compositions: {...state.compositions},
		layers: {...state.layers},
		subtitles: {...state.subtitles},
	lipSyncTracks: {...state.lipSyncTracks},
	expressions: Object.fromEntries(
		Object.entries(state.expressions ?? {}).map(([id, expression]) => [
			id,
			{
				...expression,
				dependencies: [...expression.dependencies],
			},
		]),
	),
});

export const resolvePrecomposeFrame = ({
	parentFrame,
	from,
	timeOffset = 0,
	durationInFrames,
	loop = false,
}: {
	parentFrame: number;
	from: number;
	timeOffset?: number;
	durationInFrames: number;
	loop?: boolean;
}): number | null => {
	const localFrame = parentFrame - from + timeOffset;
	if (durationInFrames <= 0 || localFrame < 0) {
		return null;
	}
	if (!loop && localFrame >= durationInFrames) {
		return null;
	}
	return loop ? localFrame % durationInFrames : localFrame;
};

export const createPrecompose = (
	state: AdvancedProjectState,
	input: CreatePrecomposeInput,
): AdvancedProjectState => {
	const parent = state.compositions[input.compositionId];
	if (!parent) {
		throw new Error(`Composition ${input.compositionId} does not exist`);
	}

	const selected = input.layerIds.map((layerId) => {
		const layer = state.layers[layerId];
		if (!layer || layer.compositionId !== input.compositionId) {
			throw new Error(`Layer ${layerId} is not in composition ${parent.id}`);
		}
		if (!parent.layerIds.includes(layerId)) {
			throw new Error(`Layer ${layerId} is not in composition ${parent.id}'s layer order`);
		}
		return layer;
	});

	const selectedIds = new Set(input.layerIds);
	if (selectedIds.size !== input.layerIds.length || input.layerIds.length === 0) {
		throw new Error('Pre-compose requires a non-empty unique layer selection');
	}
	for (const layer of selected) {
		if (layer.parentId && !selectedIds.has(layer.parentId)) {
			throw new Error(
				`Layer ${layer.id} has a parent outside the precompose selection`,
			);
		}
	}
	if (input.composition.fps !== parent.fps) {
		throw new Error('Pre-compose and parent composition must use the same FPS');
	}
	if (input.wrapper.parentId) {
		const wrapperParent = state.layers[input.wrapper.parentId];
		if (
			!wrapperParent ||
			wrapperParent.compositionId !== input.compositionId ||
			selectedIds.has(wrapperParent.id)
		) {
			throw new Error('Pre-compose wrapper parent must remain in the parent composition');
		}
	}

	if (state.compositions[input.composition.id]) {
		throw new Error(`Composition ${input.composition.id} already exists`);
	}
	if (state.layers[input.wrapper.id]) {
		throw new Error(`Layer ${input.wrapper.id} already exists`);
	}

	const next = cloneState(state);
	const childFrom = input.composition.from ?? 0;
	next.compositions[input.composition.id] = {
		...input.composition,
		layerIds: [...input.layerIds],
	};

	for (const layer of selected) {
		next.layers[layer.id] = {
			...layer,
			compositionId: input.composition.id,
			...(layer.from === undefined
				? {}
				: {from: Math.max(0, layer.from - childFrom)}),
		};
	}

	next.layers[input.wrapper.id] = {
		...input.wrapper,
		compositionId: input.compositionId,
		sourceCompositionId: input.composition.id,
	};
	next.compositions[parent.id] = {
		...parent,
		layerIds: parent.layerIds.reduce<string[]>((layerIds, layerId) => {
			if (layerId === input.layerIds[0]) {
				layerIds.push(input.wrapper.id);
			}
			if (!selectedIds.has(layerId)) {
				layerIds.push(layerId);
			}
			return layerIds;
		}, []),
	};

	return next;
};

const isIdentityTransform = (layer: LayerNode): boolean => {
	const transform = layer.transform;
	return (
		transform.x === 0 &&
		transform.y === 0 &&
		transform.scaleX === 1 &&
		transform.scaleY === 1 &&
		transform.rotation === 0 &&
		transform.opacity === 1 &&
		transform.anchorX === 0.5 &&
		transform.anchorY === 0.5 &&
		!layer.motion
	);
};

const getFlattenedTiming = ({
	layer,
	child,
	wrapper,
	parent,
}: {
	layer: LayerNode;
	child: CompositionDefinition;
	wrapper: LayerNode;
	parent: CompositionDefinition;
}): {from: number; durationInFrames: number} => {
	const layerFrom = layer.from ?? 0;
	const layerEnd = Math.min(
		child.durationInFrames,
		layerFrom +
			(layer.durationInFrames ?? Math.max(0, child.durationInFrames - layerFrom)),
	);
	const wrapperFrom = wrapper.from ?? 0;
	const wrapperEnd =
		wrapperFrom +
		(wrapper.durationInFrames ??
			Math.max(0, parent.durationInFrames - wrapperFrom));
	const timeOffset = child.timeOffset ?? 0;
	const from = Math.max(0, wrapperFrom, wrapperFrom + Math.max(0, layerFrom) - timeOffset);
	const end = Math.min(
		parent.durationInFrames,
		wrapperEnd,
		wrapperFrom + layerEnd - timeOffset,
	);

	return {
		from,
		durationInFrames: Math.max(0, end - from),
	};
};

export const flattenPrecompose = (
	state: AdvancedProjectState,
	wrapperLayerId: string,
): AdvancedProjectState => {
	const wrapper = state.layers[wrapperLayerId];
	if (!wrapper?.sourceCompositionId) {
		throw new Error(`Layer ${wrapperLayerId} is not a pre-compose wrapper`);
	}

	const parent = state.compositions[wrapper.compositionId];
	const child = state.compositions[wrapper.sourceCompositionId];
	if (!parent || !child) {
		throw new Error('Pre-compose references a missing composition');
	}
	if (wrapper.motion || !isIdentityTransform(wrapper)) {
		throw new Error(
			'Flattening an animated or transformed pre-compose is not supported',
		);
	}
	if (
		(wrapper.masks?.length ?? 0) > 0 ||
		wrapper.matte ||
		(wrapper.blendMode && wrapper.blendMode !== 'normal') ||
		wrapper.transform.width !== child.width ||
		wrapper.transform.height !== child.height
	) {
		throw new Error(
			'Flattening a pre-compose with masks, mattes, blend modes, or resized dimensions is not supported',
		);
	}

	const next = cloneState(state);
	const flattenedChildIds = child.layerIds
		.map((childLayerId) => next.layers[childLayerId])
		.filter((layer): layer is LayerNode => Boolean(layer))
		.sort((left, right) => left.zIndex - right.zIndex)
		.map((childLayer) => childLayer.id);
	for (const childLayerId of flattenedChildIds) {
		const childLayer = next.layers[childLayerId];
		if (!childLayer) {
			continue;
		}
		const timing = getFlattenedTiming({
			layer: childLayer,
			child,
			wrapper,
			parent,
		});
		next.layers[childLayerId] = {
			...childLayer,
			compositionId: parent.id,
			...timing,
			...(!childLayer.parentId
				? {parentId: wrapper.parentId ?? null}
				: {}),
			visible: childLayer.visible && wrapper.visible,
			locked: childLayer.locked || wrapper.locked,
		};
	}

	const parentLayerOrder = parent.layerIds
		.map((layerId) =>
			layerId === wrapperLayerId ? wrapper : next.layers[layerId],
		)
		.filter((layer): layer is LayerNode => Boolean(layer))
		.sort((left, right) => left.zIndex - right.zIndex)
		.flatMap((layer) =>
			layer.id === wrapperLayerId ? flattenedChildIds : [layer.id],
		);
	delete next.layers[wrapperLayerId];
	delete next.compositions[child.id];
	for (const [zIndex, layerId] of parentLayerOrder.entries()) {
		const layer = next.layers[layerId];
		if (layer) {
			next.layers[layerId] = {...layer, zIndex};
		}
	}
	next.compositions[parent.id] = {
		...parent,
		layerIds: parentLayerOrder,
	};

	return next;
};
