'use client';

import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';
import {
	DEFAULT_THEME_MODE,
	THEME_STORAGE_KEY,
	applyResolvedTheme,
	isThemeMode,
} from './storage';
import type {ResolvedTheme, ThemeMode} from './types';

type ThemeState = {
	mode: ThemeMode;
	resolvedTheme: ResolvedTheme;
};

type ThemeContextValue = ThemeState & {
	setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const readStoredThemeMode = (): ThemeMode => {
	if (typeof window === 'undefined') {
		return DEFAULT_THEME_MODE;
	}

	const storedMode = window.localStorage.getItem(THEME_STORAGE_KEY);
	return isThemeMode(storedMode) ? storedMode : DEFAULT_THEME_MODE;
};

const getInitialThemeState = (): ThemeState => {
	const mode = readStoredThemeMode();

	return {
		mode,
		resolvedTheme: mode,
	};
};

export const ThemeProvider: React.FC<{children: React.ReactNode}> = ({
	children,
}) => {
	const [theme, setTheme] = useState<ThemeState>(getInitialThemeState);

	const setMode = useCallback((mode: ThemeMode) => {
		const resolvedTheme = mode;

		applyResolvedTheme(resolvedTheme);
		window.localStorage.setItem(THEME_STORAGE_KEY, mode);
		setTheme({mode, resolvedTheme});
	}, []);

	useEffect(() => {
		applyResolvedTheme(theme.resolvedTheme);
		window.localStorage.setItem(THEME_STORAGE_KEY, theme.mode);
	}, [theme.mode, theme.resolvedTheme]);

	const value = useMemo<ThemeContextValue>(
		() => ({
			...theme,
			setMode,
		}),
		[setMode, theme],
	);

	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
};

export const useTheme = () => {
	const context = useContext(ThemeContext);

	if (!context) {
		throw new Error('useTheme must be used within ThemeProvider');
	}

	return context;
};
