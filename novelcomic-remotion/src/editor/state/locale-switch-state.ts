import {EditorState, UndoableState} from './types';

const localeSwitchStateKey = 'remotion-editor-locale-switch-state-v1';

type LocaleSwitchState = {
	undoableState: UndoableState;
	selectedItems: string[];
	textItemEditing: string | null;
	itemSelectedForCrop: string | null;
	loop: boolean;
	timelineHeight: number;
	isSnappingEnabled: boolean;
	autoKeyEnabled?: boolean;
};

const isLocaleSwitchState = (value: unknown): value is LocaleSwitchState => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const state = value as Partial<LocaleSwitchState>;

	return (
		typeof state.undoableState === 'object' &&
		state.undoableState !== null &&
		Array.isArray(state.undoableState.tracks) &&
		typeof state.undoableState.items === 'object' &&
		state.undoableState.items !== null &&
		typeof state.undoableState.assets === 'object' &&
		state.undoableState.assets !== null &&
		Array.isArray(state.selectedItems) &&
		(typeof state.textItemEditing === 'string' ||
			state.textItemEditing === null) &&
		(typeof state.itemSelectedForCrop === 'string' ||
			state.itemSelectedForCrop === null) &&
		typeof state.loop === 'boolean' &&
		typeof state.timelineHeight === 'number' &&
		typeof state.isSnappingEnabled === 'boolean'
	);
};

export const saveStateForLocaleSwitch = (state: EditorState) => {
	if (typeof sessionStorage === 'undefined') {
		return;
	}

	const stateForLocaleSwitch: LocaleSwitchState = {
		undoableState: state.undoableState,
		selectedItems: state.selectedItems,
		textItemEditing: state.textItemEditing,
		itemSelectedForCrop: state.itemSelectedForCrop,
		loop: state.loop,
		timelineHeight: state.timelineHeight,
		isSnappingEnabled: state.isSnappingEnabled,
		autoKeyEnabled: state.autoKeyEnabled,
	};

	sessionStorage.setItem(
		localeSwitchStateKey,
		JSON.stringify(stateForLocaleSwitch),
	);
};

export const clearStateFromLocaleSwitch = () => {
	if (typeof sessionStorage === 'undefined') {
		return;
	}

	sessionStorage.removeItem(localeSwitchStateKey);
};

export const loadStateFromLocaleSwitch = (): LocaleSwitchState | null => {
	if (typeof sessionStorage === 'undefined') {
		return null;
	}

	const serializedState = sessionStorage.getItem(localeSwitchStateKey);
	if (!serializedState) {
		return null;
	}

	sessionStorage.removeItem(localeSwitchStateKey);

	try {
		const parsedState = JSON.parse(serializedState);
		return isLocaleSwitchState(parsedState) ? parsedState : null;
	} catch {
		return null;
	}
};
