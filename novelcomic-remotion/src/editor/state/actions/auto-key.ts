import type {EditorState} from '../types';

export const setAutoKeyEnabled = (
	state: EditorState,
	autoKeyEnabled: boolean,
): EditorState => {
	if (state.autoKeyEnabled === autoKeyEnabled) {
		return state;
	}

	return {...state, autoKeyEnabled};
};
