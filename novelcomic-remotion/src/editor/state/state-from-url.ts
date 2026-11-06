import {FEATURE_LOAD_STATE_FROM_URL} from '../flags';
import {UndoableState} from './types';

export const getStateFromUrl = (): UndoableState | null => {
	if (!FEATURE_LOAD_STATE_FROM_URL) {
		return null;
	}

	const hash = window.location.hash;
	const state = hash.startsWith('#state=')
		? hash.slice('#state='.length)
		: null;

	if (!state) {
		return null;
	}

	try {
		const base64Decoded = decodeURIComponent(escape(atob(state)));
		return JSON.parse(base64Decoded);
	} catch {
		return null;
	}
};
