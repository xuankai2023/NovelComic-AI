import type {LayerGroup} from '../../advanced/types';
import type {EditorState, TrackType, UndoableState} from '../types';

const groupsOf = (state: UndoableState) => state.layerGroups ?? {};

const withGroups = (
	state: EditorState,
	layerGroups: Record<string, LayerGroup>,
): EditorState => ({
	...state,
	undoableState: {
		...state.undoableState,
		layerGroups,
	},
});

export const createLayerGroup = (
	state: EditorState,
	group: LayerGroup,
): EditorState => {
	const groups = groupsOf(state.undoableState);
	const existingTrackIds = new Set(
		Object.values(groups).flatMap((candidate) => candidate.trackIds),
	);
	const parent = group.parentGroupId ? groups[group.parentGroupId] : undefined;
	if (
		groups[group.id] ||
		group.trackIds.length === 0 ||
		(group.parentGroupId !== undefined && !parent) ||
		group.parentGroupId === group.id ||
		group.trackIds.some((trackId) => existingTrackIds.has(trackId)) ||
		group.trackIds.some(
			(trackId) =>
				!state.undoableState.tracks.some((track) => track.id === trackId),
		)
	) {
		return state;
	}

	return withGroups(state, {
		...groups,
		[group.id]: {...group, trackIds: [...group.trackIds]},
	});
};

export const updateLayerGroup = (
	state: EditorState,
	groupId: string,
	patch: Partial<Omit<LayerGroup, 'id'>>,
): EditorState => {
	const group = groupsOf(state.undoableState)[groupId];
	if (!group) return state;
	const nextParentId = patch.parentGroupId ?? group.parentGroupId;
	const groups = groupsOf(state.undoableState);
	const createsCycle = (parentId: string | undefined): boolean => {
		const seen = new Set<string>();
		let current = parentId;
		while (current) {
			if (current === groupId || seen.has(current)) return true;
			seen.add(current);
			current = groups[current]?.parentGroupId;
		}
		return false;
	};
	if (
		(nextParentId !== undefined && !groups[nextParentId]) ||
		createsCycle(nextParentId)
	) {
		return state;
	}
	const nextTrackIds = patch.trackIds ?? group.trackIds;
	const ownedByOtherGroup = new Set(
		Object.values(groups)
			.filter((candidate) => candidate.id !== groupId)
			.flatMap((candidate) => candidate.trackIds),
	);
	if (
		nextTrackIds.some((trackId) => ownedByOtherGroup.has(trackId)) ||
		nextTrackIds.some(
			(trackId) =>
				!state.undoableState.tracks.some((track) => track.id === trackId),
		)
	) {
		return state;
	}
	return withGroups(state, {
		...groups,
		[groupId]: {
			...group,
			...patch,
			parentGroupId: nextParentId,
			trackIds: [...nextTrackIds],
		},
	});
};

export const deleteLayerGroup = (
	state: EditorState,
	groupId: string,
): EditorState => {
	const groups = {...groupsOf(state.undoableState)};
	if (!groups[groupId]) return state;
	delete groups[groupId];

	for (const [id, group] of Object.entries(groups)) {
		if (group.parentGroupId === groupId) {
			groups[id] = {...group, parentGroupId: undefined};
		}
	}

	return withGroups(state, groups);
};

export const toggleLayerGroupVisibility = (
	state: EditorState,
	groupId: string,
): EditorState => {
	const group = groupsOf(state.undoableState)[groupId];
	return group
		? updateLayerGroup(state, groupId, {visible: !group.visible})
		: state;
};

export const toggleLayerGroupLocked = (
	state: EditorState,
	groupId: string,
): EditorState => {
	const group = groupsOf(state.undoableState)[groupId];
	return group
		? updateLayerGroup(state, groupId, {locked: !group.locked})
		: state;
};

const parentChain = (
	groups: Record<string, LayerGroup>,
	groupId: string | undefined,
) => {
	const chain: LayerGroup[] = [];
	const seen = new Set<string>();
	let current = groupId;
	while (current && !seen.has(current)) {
		seen.add(current);
		const group = groups[current];
		if (!group) break;
		chain.push(group);
		current = group.parentGroupId;
	}
	return chain;
};

export const getGroupsForTrack = (
	state: UndoableState,
	trackId: string,
): LayerGroup[] => {
	const groups = groupsOf(state);
	const direct = Object.values(groups).find((group) =>
		group.trackIds.includes(trackId),
	);
	return parentChain(groups, direct?.id);
};

export const isTrackHiddenByLayerGroup = (
	state: UndoableState,
	trackId: string,
): boolean => getGroupsForTrack(state, trackId).some((group) => !group.visible);

export const isTrackLockedByLayerGroup = (
	state: UndoableState,
	trackId: string,
): boolean => getGroupsForTrack(state, trackId).some((group) => group.locked);

export const isItemOnLockedLayerGroup = (
	state: UndoableState,
	itemId: string,
): boolean => {
	const track = state.tracks.find((candidate) =>
		candidate.items.includes(itemId),
	);
	return track ? isTrackLockedByLayerGroup(state, track.id) : false;
};

export const getTracksForLayerGroup = (
	state: UndoableState,
	groupId: string,
): TrackType[] => {
	const group = groupsOf(state)[groupId];
	return group
		? group.trackIds
				.map((trackId) => state.tracks.find((track) => track.id === trackId))
				.filter((track): track is TrackType => Boolean(track))
		: [];
};
