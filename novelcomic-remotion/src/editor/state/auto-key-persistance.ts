const key = 'remotion-editor-starter.auto-key-enabled';

export const DEFAULT_AUTO_KEY_ENABLED = false;

export const loadAutoKeyEnabled = () => {
	if (typeof localStorage === 'undefined') {
		return DEFAULT_AUTO_KEY_ENABLED;
	}

	const value = localStorage.getItem(key);
	if (value === null) {
		return DEFAULT_AUTO_KEY_ENABLED;
	}
	return value === 'true';
};

export const saveAutoKeyEnabled = (enabled: boolean) => {
	localStorage.setItem(key, enabled.toString());
};
