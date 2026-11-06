import type {ResolvedTheme, ThemeMode} from './types';

export const THEME_STORAGE_KEY = 'opencreator-theme';
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

export const isThemeMode = (value: unknown): value is ThemeMode => {
	return value === 'light' || value === 'dark';
};

export const applyResolvedTheme = (resolvedTheme: ResolvedTheme) => {
	if (typeof document === 'undefined') {
		return;
	}

	document.documentElement.dataset.theme = resolvedTheme;
	document.documentElement.style.colorScheme = resolvedTheme;
};
