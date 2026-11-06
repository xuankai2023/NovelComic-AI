const PROJECT_ID_STORAGE_KEY = 'novelcomic-editor-project-id';

export const getClientProjectId = (): string => {
	if (typeof window === 'undefined') {
		return 'editor-local-project';
	}

	try {
		const existing = window.localStorage.getItem(PROJECT_ID_STORAGE_KEY);
		if (existing?.trim()) {
			return existing;
		}

		const generated =
			typeof window.crypto?.randomUUID === 'function'
				? window.crypto.randomUUID()
				: `editor-project-${Date.now().toString(36)}`;
		window.localStorage.setItem(PROJECT_ID_STORAGE_KEY, generated);
		return generated;
	} catch {
		return 'editor-local-project';
	}
};
