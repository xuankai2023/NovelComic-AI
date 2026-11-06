import {createPrecompose, type CreatePrecomposeInput} from './precompose';
import type {
	AdvancedProjectState,
	AdvancedTransform,
	LayerNode,
	MaskDefinition,
	TrackMatteDefinition,
} from './types';
import {resolveWorldTransform} from '../hierarchy/resolve-parent-transform';
import {validateTrackMattes} from '../masks/track-matte';

const cloneAdvancedState = (
	state: AdvancedProjectState,
): AdvancedProjectState => ({
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

const assertLayer = (
	state: AdvancedProjectState,
	layerId: string,
): LayerNode => {
	const layer = state.layers[layerId];
	if (!layer) {
		throw new Error(`Layer ${layerId} does not exist`);
	}
	return layer;
};

const wouldCreateCycle = (
	state: AdvancedProjectState,
	layerId: string,
	parentId: string | null,
): boolean => {
	let current = parentId;
	const visited = new Set<string>();
	while (current) {
		if (current === layerId) {
			return true;
		}
		if (visited.has(current)) {
			return true;
		}
		visited.add(current);
		current = state.layers[current]?.parentId ?? null;
	}
	return false;
};

export const setAdvancedLayerParent = (
	state: AdvancedProjectState,
	input: {
		layerId: string;
		parentId: string | null;
		keepWorldTransform?: boolean;
		frame?: number;
	},
): AdvancedProjectState => {
	const layer = assertLayer(state, input.layerId);
	if (input.parentId === input.layerId) {
		throw new Error('A layer cannot be its own parent');
	}
	if (input.parentId) {
		const parent = assertLayer(state, input.parentId);
		if (parent.compositionId !== layer.compositionId) {
			throw new Error('Parent and child must belong to the same composition');
		}
		if (wouldCreateCycle(state, input.layerId, input.parentId)) {
			throw new Error('Layer hierarchy contains a cycle');
		}
	}

	const next = cloneAdvancedState(state);
	const frame = input.frame ?? 0;
	const world = input.keepWorldTransform
		? resolveWorldTransform(input.layerId, state.layers, frame)
		: null;
	const parentWorld = input.parentId
		? resolveWorldTransform(input.parentId, state.layers, frame)
		: null;
	if (
		world &&
		parentWorld &&
		(parentWorld.scaleX === 0 || parentWorld.scaleY === 0)
	) {
		throw new Error(
			'Cannot preserve world transform under a parent with zero scale',
		);
	}
	const local = world
		? parentWorld
			? {
					...world,
					x:
						((world.x - parentWorld.x) * Math.cos((-parentWorld.rotation * Math.PI) / 180) -
							(world.y - parentWorld.y) *
								Math.sin((-parentWorld.rotation * Math.PI) / 180)) /
						(parentWorld.scaleX || 1),
					y:
						((world.x - parentWorld.x) * Math.sin((-parentWorld.rotation * Math.PI) / 180) +
							(world.y - parentWorld.y) *
								Math.cos((-parentWorld.rotation * Math.PI) / 180)) /
						(parentWorld.scaleY || 1),
					scaleX: world.scaleX / (parentWorld.scaleX || 1),
					scaleY: world.scaleY / (parentWorld.scaleY || 1),
					rotation: world.rotation - parentWorld.rotation,
					opacity: world.opacity / (parentWorld.opacity || 1),
				}
			: world
		: layer.transform;
	next.layers[input.layerId] = {
		...layer,
		parentId: input.parentId,
		transform: local,
	};

	return next;
};

export const updateAdvancedLayerTransform = (
	state: AdvancedProjectState,
	input: {
		layerId: string;
		patch: Partial<AdvancedTransform>;
	},
): AdvancedProjectState => {
	const layer = assertLayer(state, input.layerId);
	const next = cloneAdvancedState(state);
	next.layers[input.layerId] = {
		...layer,
		transform: {...layer.transform, ...input.patch},
	};
	return next;
};

export const setAdvancedLayerVisibility = (
	state: AdvancedProjectState,
	layerId: string,
	visible: boolean,
): AdvancedProjectState => {
	const layer = assertLayer(state, layerId);
	const next = cloneAdvancedState(state);
	next.layers[layerId] = {...layer, visible};
	return next;
};

export const setAdvancedLayerLock = (
	state: AdvancedProjectState,
	layerId: string,
	locked: boolean,
): AdvancedProjectState => {
	const layer = assertLayer(state, layerId);
	const next = cloneAdvancedState(state);
	next.layers[layerId] = {...layer, locked};
	return next;
};

export const setAdvancedLayerMasks = (
	state: AdvancedProjectState,
	input: {layerId: string; masks: MaskDefinition[]},
): AdvancedProjectState => {
	const layer = assertLayer(state, input.layerId);
	const next = cloneAdvancedState(state);
	next.layers[input.layerId] = {
		...layer,
		...(input.masks.length > 0 ? {masks: input.masks} : {}),
	};
	if (input.masks.length === 0) {
		delete next.layers[input.layerId]!.masks;
	}
	return next;
};

export const setAdvancedLayerMatte = (
	state: AdvancedProjectState,
	input: {layerId: string; matte: TrackMatteDefinition | undefined},
): AdvancedProjectState => {
	const layer = assertLayer(state, input.layerId);
	if (input.matte?.layerId === input.layerId) {
		throw new Error('A layer cannot use itself as a track matte');
	}
	if (input.matte) {
		const matteLayer = assertLayer(state, input.matte.layerId);
		if (matteLayer.compositionId !== layer.compositionId) {
			throw new Error('Track Matte must belong to the same composition');
		}
	}

	const next = cloneAdvancedState(state);
	next.layers[input.layerId] = {
		...layer,
		...(input.matte ? {matte: {...input.matte}} : {}),
	};
	if (!input.matte) {
		delete next.layers[input.layerId]!.matte;
	}

	const issue = validateTrackMattes(next).find(
		(candidate) => candidate.layerId === input.layerId,
	);
	if (issue) {
		throw new Error(issue.message);
	}
	return next;
};

export const createAdvancedLayerFromItem = (
	state: AdvancedProjectState,
	input: {
		layerId: string;
		itemId: string;
		compositionId?: string;
		name: string;
		transform: AdvancedTransform;
		from?: number;
		durationInFrames?: number;
		zIndex?: number;
	},
): AdvancedProjectState => {
	if (state.layers[input.layerId]) {
		throw new Error(`Layer ${input.layerId} already exists`);
	}

	const compositionId = input.compositionId ?? state.rootCompositionId;
	const composition = state.compositions[compositionId];
	if (!composition) {
		throw new Error(`Composition ${compositionId} does not exist`);
	}

	const next = cloneAdvancedState(state);
	const layer: LayerNode = {
		id: input.layerId,
		itemId: input.itemId,
		compositionId,
		name: input.name,
		zIndex: input.zIndex ?? composition.layerIds.length,
		visible: true,
		locked: false,
		transform: input.transform,
		...(input.from === undefined ? {} : {from: input.from}),
		...(input.durationInFrames === undefined
			? {}
			: {durationInFrames: input.durationInFrames}),
	};
	next.layers[layer.id] = layer;
	next.compositions[compositionId] = {
		...composition,
		layerIds: [...composition.layerIds, layer.id],
	};
	return next;
};

export const createAdvancedPrecompose = (
	state: AdvancedProjectState,
	input: CreatePrecomposeInput,
): AdvancedProjectState => createPrecompose(state, input);

export const removeAdvancedLayer = (
	state: AdvancedProjectState,
	layerId: string,
): AdvancedProjectState => {
	const layer = assertLayer(state, layerId);
	const next = cloneAdvancedState(state);
	delete next.layers[layerId];
	const composition = next.compositions[layer.compositionId];
	if (composition) {
		next.compositions[layer.compositionId] = {
			...composition,
			layerIds: composition.layerIds.filter((id) => id !== layerId),
		};
	}
	for (const candidate of Object.values(next.layers)) {
		if (candidate.parentId === layerId) {
			next.layers[candidate.id] = {...candidate, parentId: null};
		}
	}
	return next;
};
