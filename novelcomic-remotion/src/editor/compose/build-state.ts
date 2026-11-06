import {EditorStarterAsset} from '../assets/assets';
import {
	COMIC_DEFAULT_FPS,
	COMIC_DEFAULT_HEIGHT,
	COMIC_DEFAULT_WIDTH,
	COMIC_SCHEMA_VERSION,
} from '../comic/limits';
import {
	DEFAULT_COMPOSITION_HEIGHT,
	DEFAULT_COMPOSITION_WIDTH,
	DEFAULT_FPS,
} from '../constants';
import {EditorStarterItem} from '../items/item-type';
import {TrackType, UndoableState} from '../state/types';
import {generateRandomId} from '../utils/generate-random-id';

export const createEmptyState = (opts?: {
	compositionWidth?: number;
	compositionHeight?: number;
	fps?: number;
	schemaVersion?: number;
}): UndoableState => {
	const state: UndoableState = {
		tracks: [],
		items: {},
		assets: {},
		fps: opts?.fps ?? DEFAULT_FPS,
		compositionWidth: opts?.compositionWidth ?? DEFAULT_COMPOSITION_WIDTH,
		compositionHeight: opts?.compositionHeight ?? DEFAULT_COMPOSITION_HEIGHT,
		deletedAssets: [],
	};

	if (opts?.schemaVersion === undefined) {
		return state;
	}

	return {
		...state,
		schemaVersion: opts.schemaVersion,
		shots: [],
	};
};

export const createComicProject = (opts?: {
	compositionWidth?: number;
	compositionHeight?: number;
	fps?: number;
}): UndoableState => {
	return createEmptyState({
		compositionWidth: opts?.compositionWidth ?? COMIC_DEFAULT_WIDTH,
		compositionHeight: opts?.compositionHeight ?? COMIC_DEFAULT_HEIGHT,
		fps: opts?.fps ?? COMIC_DEFAULT_FPS,
		schemaVersion: COMIC_SCHEMA_VERSION,
	});
};

export const getTimelineEndFrame = (state: UndoableState): number => {
	let maxEnd = 0;
	for (const item of Object.values(state.items)) {
		const end = item.from + item.durationInFrames;
		if (end > maxEnd) {
			maxEnd = end;
		}
	}
	return maxEnd;
};

export const appendItemToState = ({
	state,
	item,
	asset,
	trackId,
	prepend,
}: {
	state: UndoableState;
	item: EditorStarterItem;
	asset: EditorStarterAsset;
	trackId?: string;
	prepend?: boolean;
}): UndoableState => {
	const newItems = {...state.items, [item.id]: item};
	const newAssets = {...state.assets, [asset.id]: asset};

	let newTracks: TrackType[];

	if (trackId) {
		newTracks = state.tracks.map((t) =>
			t.id === trackId ? {...t, items: [...t.items, item.id]} : t,
		);
	} else {
		const newTrack: TrackType = {
			id: generateRandomId(),
			items: [item.id],
			hidden: false,
			muted: false,
		};
		newTracks = prepend
			? [newTrack, ...state.tracks]
			: [...state.tracks, newTrack];
	}

	return {
		...state,
		items: newItems,
		assets: newAssets,
		tracks: newTracks,
	};
};

export const appendItemsToTrack = ({
	state,
	items,
	assets,
}: {
	state: UndoableState;
	items: EditorStarterItem[];
	assets: EditorStarterAsset[];
}): UndoableState => {
	const newItems = {...state.items};
	const newAssets = {...state.assets};

	for (const item of items) {
		newItems[item.id] = item;
	}
	for (const asset of assets) {
		newAssets[asset.id] = asset;
	}

	const newTrack: TrackType = {
		id: generateRandomId(),
		items: items.map((i) => i.id),
		hidden: false,
		muted: false,
	};

	return {
		...state,
		items: newItems,
		assets: newAssets,
		tracks: [...state.tracks, newTrack],
	};
};
